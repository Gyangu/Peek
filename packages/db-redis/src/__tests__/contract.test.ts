import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KEYSPACE_SCAN_SCHEMA,
  encodeScanCursor,
  isPeekError,
  keyValueAddressing,
  keyValueReadOptions,
  type KeyValueWindow,
  type NamespaceNode,
} from '@peek/core'
import { redisDriver, requireRedisConfig } from '../driver'
import { isRedisCommandRefusal, mapRedisError, redisErrorPrefix } from '../errors'
import { redisManifest } from '../manifest'
import {
  MAX_PREFIX_NODES,
  PREFIX_SAMPLE_KEYS,
  RedisKeyspace,
  keyspaceNodeId,
  parseKeyspaceNodeId,
  splitKeyPrefix,
  type KeyspaceDeps,
} from '../keyspace'
import { isRedisResumeToken, parseRedisResumeToken, redisResumeToken } from '../scan'
import { REDIS_TYPE_TO_SHAPE, redisTypeShape } from '../values'

/**
 * Contract tests: no redis server involved. They pin the parts of the driver the
 * rest of the system is allowed to depend on — the advertised capability set, the
 * node-id codec, the error classification — so the M3 implementation cannot drift
 * away from them while filling in the sessions.
 */

describe('db-redis contract', () => {
  it('advertises exactly the capability set this package declares for itself', () => {
    // Against the package's own manifest, which is what the connect dialog and
    // the MCP tools read before anything has connected. The two used to be
    // pinned to a table in core that the driver imported back — self-consistent,
    // and describing the package from outside it.
    assert.deepEqual([...redisDriver.capabilities].sort(), [...redisManifest.capabilities].sort())
    assert.equal(redisDriver.meta.id, 'redis')
  })

  it('rejects a config routed to the wrong driver', () => {
    assert.deepEqual(
      requireRedisConfig({ driverId: 'redis', url: 'redis://localhost:6379' }).driverId,
      'redis',
    )
    try {
      requireRedisConfig({ driverId: 'postgres', url: 'postgresql://localhost/x' })
      assert.fail('a postgres config must not be accepted')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })

  it('round-trips node ids, including keys that contain the delimiter', () => {
    assert.equal(parseKeyspaceNodeId(keyspaceNodeId.database(3)).kind, 'database')
    const parsed = parseKeyspaceNodeId(keyspaceNodeId.key(2, 'user:42:sessions'))
    assert.deepEqual(parsed, { kind: 'key', db: 2, key: 'user:42:sessions' })
    const prefix = parseKeyspaceNodeId(keyspaceNodeId.prefix(0, 'user'))
    assert.deepEqual(prefix, { kind: 'prefix', db: 0, prefix: 'user' })
    assert.equal(parseKeyspaceNodeId('nonsense').kind, 'unknown')
    assert.equal(parseKeyspaceNodeId('db:notanumber').kind, 'unknown')
  })

  it('splits a key into its first prefix segment', () => {
    assert.deepEqual(splitKeyPrefix('user:42:sessions'), { head: 'user', rest: '42:sessions' })
    assert.deepEqual(splitKeyPrefix('user:42:sessions', ':', 'user:'), { head: '42', rest: 'sessions' })
    assert.equal(splitKeyPrefix('flat'), null)
  })

  it('maps every redis type to an inspector shape, missing keys included', () => {
    assert.equal(REDIS_TYPE_TO_SHAPE.zset, 'sortedSet')
    assert.equal(REDIS_TYPE_TO_SHAPE.none, 'missing')
    assert.equal(redisTypeShape('hash'), 'map')
    // An unknown type still renders rather than crashing the inspector
    assert.equal(redisTypeShape('module-defined-thing'), 'scalar')
  })

  it('classifies redis reply errors by their prefix, keeping the server text verbatim', () => {
    const wrongType = mapRedisError(
      new Error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      { command: 'LRANGE user:42 0 10' },
    )
    assert.equal(wrongType.code, 'QUERY_FAILED')
    assert.equal(wrongType.driverCode, 'WRONGTYPE')
    assert.match(wrongType.message, /^WRONGTYPE /)
    // Server text is evidence: it must not carry an i18n descriptor
    assert.equal(wrongType.i18n, undefined)
    assert.match(String(wrongType.detail), /LRANGE user:42 0 10/)

    const loading = mapRedisError(new Error('LOADING Redis is loading the dataset in memory'))
    assert.equal(loading.retryable, true)

    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    })
    assert.equal(mapRedisError(refused).code, 'CONNECTION_FAILED')

    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
    assert.equal(mapRedisError(aborted).code, 'CANCELLED')

    assert.equal(redisErrorPrefix('lowercase words only'), undefined)
    assert.equal(redisErrorPrefix('NOPERM this user has no permissions'), 'NOPERM')
  })

  /**
   * The discriminator the keyspace scan degrades on.
   *
   * "Every element of the batch failed" is not evidence of a broken connection —
   * on a managed redis with a restricted ACL it is the *normal* answer to
   * `MEMORY USAGE`, and treating it as a transport failure makes the keyspace
   * browser unusable there. The reason is what says which.
   */
  it('tells a refused command apart from a failed connection', () => {
    const refusals = [
      "NOPERM User peekprobe has no permissions to run the 'memory|usage' command",
      'ERR unknown command `OBJECT`, with args beginning with:',
      'ERR no such key',
      'WRONGTYPE Operation against a key holding the wrong kind of value',
      'OOM command not allowed when used memory > maxmemory',
    ]
    for (const message of refusals) {
      assert.equal(isRedisCommandRefusal(new Error(message)), true, message)
    }

    const connectionFailures: unknown[] = [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      new Error('The client is closed'),
      new Error('Socket closed unexpectedly'),
      // Authentication and availability are properties of the connection, not of
      // the one command that happened to notice
      new Error('NOAUTH Authentication required'),
      new Error('LOADING Redis is loading the dataset in memory'),
      new Error('CLUSTERDOWN Hash slot not served'),
      'not an error at all',
    ]
    for (const value of connectionFailures) {
      assert.equal(isRedisCommandRefusal(value), false, String(value))
    }
  })

  /**
   * The window contract, which the flat `KeyValueReadOptions` bag used to let
   * anyone get wrong.
   *
   * Redis is the only driver that implements `keyValue`, so this is where the
   * shape ↔ addressing table is pinned. The compile-time half lives in the type
   * itself (`{ shape: 'map', offset: 3 }` does not typecheck); this is the runtime
   * half, for windows that arrive as JSON from another process and are therefore
   * not checked by anything else.
   */
  it('addresses each value shape by exactly one of a cursor and an index', () => {
    assert.equal(keyValueAddressing('map'), 'cursor')
    assert.equal(keyValueAddressing('set'), 'cursor')
    // XRANGE addresses by entry id, so a stream continues on a cursor even
    // though `offset` is also honoured (by over-reading and slicing)
    assert.equal(keyValueAddressing('stream'), 'cursor')
    assert.equal(keyValueAddressing('list'), 'offset')
    assert.equal(keyValueAddressing('sortedSet'), 'offset')
    assert.equal(keyValueAddressing('scalar'), 'none')
    assert.equal(keyValueAddressing('missing'), 'none')

    // The redis TYPE table and the addressing table have to agree: every shape a
    // redis type maps to is one this driver can actually window
    for (const shape of Object.values(REDIS_TYPE_TO_SHAPE)) {
      assert.ok(['cursor', 'offset', 'none'].includes(keyValueAddressing(shape)), shape)
    }
  })

  it('rejects a wire window that addresses a shape the way another shape is addressed', () => {
    const rejected: KeyValueWindow[] = [
      // An offset into a hash: HSCAN has no index, and the old flat type let this
      // through to be silently ignored — the caller got page 1 again, forever
      { shape: 'map', offset: 200 },
      { shape: 'set', offset: 0 },
      // A cursor into a list: LRANGE takes numbers, and an opaque cursor coerces
      // to NaN, which reads as offset 0
      { shape: 'list', cursorToken: '17' },
      { shape: 'sortedSet', cursorToken: 'abc' },
      // A scalar is paged by bytes through valuePeek, not by elements
      { shape: 'scalar', offset: 10 },
      { shape: 'missing', cursorToken: '1' },
    ]
    for (const window of rejected) {
      try {
        keyValueReadOptions(window)
        assert.fail(`${JSON.stringify(window)} must be refused`)
      } catch (err) {
        assert.ok(isPeekError(err), 'the refusal has to be a structured error')
        assert.equal(err.code, 'BAD_REQUEST')
      }
    }
  })

  it('accepts the legal windows and infers the member when no shape was declared', () => {
    assert.deepEqual(keyValueReadOptions(undefined), {})
    assert.deepEqual(keyValueReadOptions({ limit: 50 }), { limit: 50 })
    assert.deepEqual(keyValueReadOptions({ shape: 'map', cursorToken: '17', match: 'f*' }), {
      shape: 'map',
      cursorToken: '17',
      match: 'f*',
    })
    assert.deepEqual(keyValueReadOptions({ shape: 'list', offset: 3, limit: 10 }), {
      limit: 10,
      shape: 'list',
      offset: 3,
    })
    // A stream is the one shape that legitimately carries both
    assert.deepEqual(keyValueReadOptions({ shape: 'stream', offset: 2, cursorToken: '(1-0' }), {
      shape: 'stream',
      offset: 2,
      cursorToken: '(1-0',
    })

    // No shape declared: the addressing decides which member it becomes, and the
    // driver still re-dispatches on the key's real TYPE afterwards
    assert.equal(keyValueReadOptions({ cursorToken: '17' }).shape, 'map')
    assert.equal(keyValueReadOptions({ offset: 4 }).shape, 'list')
    assert.equal(keyValueReadOptions({ offset: 4, cursorToken: '(1-0' }).shape, 'stream')
  })

  /** The continuation token: a bare SCAN boundary, or a boundary plus an intra-page skip */
  it('round-trips the two-part scan continuation token', () => {
    // The same two-part shape as before — a SCAN boundary plus the rows of that
    // page already delivered — now carried in core's envelope, which adds the
    // minting driver so another driver's token cannot be mistaken for one
    assert.equal(isRedisResumeToken(redisResumeToken('0', 0)), true)
    assert.equal(isRedisResumeToken(redisResumeToken('238', 0)), true)
    assert.equal(isRedisResumeToken(redisResumeToken('238', 17)), true)
    assert.deepEqual(parseRedisResumeToken(redisResumeToken('238', 0)), { cursor: '238', skip: 0 })
    assert.deepEqual(parseRedisResumeToken(redisResumeToken('238', 17)), { cursor: '238', skip: 17 })

    // Malformed, in every way the old private syntax could be malformed …
    assert.equal(isRedisResumeToken(''), false)
    assert.equal(isRedisResumeToken('238:'), false)
    assert.equal(isRedisResumeToken('abc'), false)
    assert.equal(isRedisResumeToken('-1'), false)
    // … including a boundary that is not a decimal SCAN cursor
    assert.equal(isRedisResumeToken(encodeScanCursor({ driverId: 'redis', boundary: 'x', skip: 0 })), false)
    // … and, new, a well-formed token from a different driver
    assert.equal(
      isRedisResumeToken(encodeScanCursor({ driverId: 'qdrant', boundary: '42', skip: 0 })),
      false,
    )
    // The old bare forms are no longer tokens: they carry no driver, and reading
    // one would resume a scan from a boundary nobody in this session minted
    assert.equal(isRedisResumeToken('238'), false)
    assert.equal(isRedisResumeToken('238:17'), false)

    // An unparsable token restarts the iteration rather than throwing — the scan
    // is validated by the session, and this decoder must never invent a boundary
    assert.deepEqual(parseRedisResumeToken('238:17'), { cursor: '0', skip: 0 })
  })

  it('reuses the keyspace scan schema core declares, rather than a private copy', () => {
    assert.deepEqual(
      KEYSPACE_SCAN_SCHEMA.map((c) => c.name),
      ['key', 'type', 'ttlMs', 'size', 'bytes', 'encoding'],
    )
    assert.equal(KEYSPACE_SCAN_SCHEMA[0]?.primaryKey, true)
  })
})

/* ------------------------------------------------------------------ */

/**
 * A SCAN over a synthetic keyspace, so the sample ceiling can be crossed without
 * a server and without redis bucket order deciding the outcome.
 *
 * The cursor is a plain offset and MATCH is ignored, which is only sound because
 * every test below lists the database level (`base === ''`, MATCH `*`). A test
 * that expands a prefix node would need the filter.
 */
function fakeDeps(keys: readonly string[]): KeyspaceDeps {
  return {
    scanPage: async (_db, cursor, _match, count) => {
      const at = Number(cursor)
      const end = Math.min(at + count, keys.length)
      return { cursor: end >= keys.length ? '0' : String(end), keys: keys.slice(at, end) }
    },
    keyCounts: async () => new Map([[0, keys.length]]),
    databaseCount: async () => 16,
  }
}

function elisions(nodes: readonly NamespaceNode[]): NamespaceNode[] {
  return nodes.filter((n) => n.elision !== undefined)
}

/* ==================================================================
 * A level the sample could not finish has to say so.
 *
 * The tree stops at PREFIX_SAMPLE_KEYS, which is the design (see keyspace.ts:
 * the tree is orientation, the scan is truth). What was a defect is that
 * stopping was silent: prefixes the sample *reached* carried `(sampled)`, keys
 * it never reached were absent with nothing standing in for them, and the two
 * folded nodes keyed off MAX_PREFIX_NODES — a presentation cap — rather than off
 * the read having been cut short.
 * ================================================================== */

describe('db-redis namespace tree, truncated levels', () => {
  it('says nothing about truncation when the scan reached the end', async () => {
    const tree = new RedisKeyspace(fakeDeps(['user:1', 'user:2', 'tags', 'queue:jobs']))
    const level = await tree.listChildren('db:0')

    assert.deepEqual(level.map((n) => n.name).sort(), ['queue', 'tags', 'user'])
    assert.deepEqual(elisions(level), [], 'a complete level must not claim to be missing anything')
    // The counts on a complete level are facts, and keep saying so
    assert.equal(level.find((n) => n.name === 'user')?.detail, '2 keys')
  })

  it('ends a cut-short level with an elision that carries no number', async () => {
    // 3_000 keys under one prefix, then a single leaf key. The SCAN stops at
    // 2_000, so `tags` is never read — this is the shape that used to render as
    // a level with one confident-looking node and no hint that anything is
    // missing.
    const keys = [...Array(3_000).keys()].map((i) => `bulk:${i}`).concat('tags')
    const level = await new RedisKeyspace(fakeDeps(keys)).listChildren('db:0')

    assert.equal(level.find((n) => n.name === 'bulk')?.kind, 'keyPrefix')
    assert.equal(
      level.find((n) => n.name === 'tags'),
      undefined,
      'the premise: a key past the ceiling is absent from the level, not folded into it',
    )

    const marked = elisions(level)
    assert.equal(marked.length, 1, 'exactly one row stands for the unread remainder')
    const [truncated] = marked
    assert.ok(truncated?.id.endsWith('#truncated'))
    assert.equal(truncated.ref, undefined, 'there is no pattern that means "what I did not read"')
    assert.equal(truncated.hasChildren, false)
    assert.equal(
      truncated.elision?.remaining,
      undefined,
      'the driver stopped reading, so it has no honest count of what is left',
    )
    // Pinned as a shape, not as wording: whatever this row is reworded to, it
    // must not acquire a figure. A number here would be a count of what the
    // sample happened to see, printed where it reads as the whole remainder.
    assert.doesNotMatch(String(truncated.detail), /\d/)
  })

  it('counts a folded prefix tail only when the sample saw the whole level', async () => {
    // Complete: every distinct head is in `groups`, so the leftover is exact
    const heads = MAX_PREFIX_NODES + 100
    const whole = [...Array(heads).keys()].map((i) => `p${String(i).padStart(4, '0')}:x`)
    const completeLevel = await new RedisKeyspace(fakeDeps(whole)).listChildren('db:0')
    const counted = completeLevel.find((n) => n.id.endsWith('#more-prefixes'))
    assert.equal(counted?.elision?.remaining, heads - MAX_PREFIX_NODES)
    assert.equal(counted?.detail, `${heads - MAX_PREFIX_NODES} more prefixes`)

    // Cut short: the same arithmetic now counts only the heads the sample
    // reached, so the number goes away rather than understating the level
    const cycled = [...Array(PREFIX_SAMPLE_KEYS * 2).keys()].map(
      (i) => `p${String(i % heads).padStart(4, '0')}:${i}`,
    )
    const cutLevel = await new RedisKeyspace(fakeDeps(cycled)).listChildren('db:0')
    const uncounted = cutLevel.find((n) => n.id.endsWith('#more-prefixes'))
    assert.ok(uncounted, 'the level still has more prefixes than it draws')
    assert.equal(uncounted.elision?.remaining, undefined)
    assert.doesNotMatch(String(uncounted.detail), /\d/)
    assert.ok(
      cutLevel.some((n) => n.id.endsWith('#truncated')),
      'the unread remainder gets its own row even when a folded tail is already there',
    )
  })
})
