import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DRIVER_CAPABILITIES, KEYSPACE_SCAN_SCHEMA, isPeekError } from '@peek/core'
import { redisDriver, requireRedisConfig } from '../driver'
import { isRedisCommandRefusal, mapRedisError, redisErrorPrefix } from '../errors'
import { keyspaceNodeId, parseKeyspaceNodeId, splitKeyPrefix } from '../keyspace'
import { isRedisResumeToken, parseRedisResumeToken } from '../scan'
import { REDIS_TYPE_TO_SHAPE, redisTypeShape } from '../values'

/**
 * Contract tests: no redis server involved. They pin the parts of the driver the
 * rest of the system is allowed to depend on — the advertised capability set, the
 * node-id codec, the error classification — so the M3 implementation cannot drift
 * away from them while filling in the sessions.
 */

describe('driver-redis contract', () => {
  it('advertises exactly the capability set core declares for redis', () => {
    assert.deepEqual([...redisDriver.capabilities].sort(), [...DRIVER_CAPABILITIES.redis].sort())
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

  /** The continuation token: a bare SCAN boundary, or a boundary plus an intra-page skip */
  it('round-trips the two-part scan continuation token', () => {
    assert.equal(isRedisResumeToken('0'), true)
    assert.equal(isRedisResumeToken('238'), true)
    assert.equal(isRedisResumeToken('238:17'), true)
    assert.equal(isRedisResumeToken(''), false)
    assert.equal(isRedisResumeToken('238:'), false)
    assert.equal(isRedisResumeToken('abc'), false)
    assert.equal(isRedisResumeToken('238:17:4'), false)
    assert.equal(isRedisResumeToken('-1'), false)

    assert.deepEqual(parseRedisResumeToken('238'), { cursor: '238', skip: 0 })
    assert.deepEqual(parseRedisResumeToken('238:17'), { cursor: '238', skip: 17 })
  })

  it('reuses the keyspace scan schema core declares, rather than a private copy', () => {
    assert.deepEqual(
      KEYSPACE_SCAN_SCHEMA.map((c) => c.name),
      ['key', 'type', 'ttlMs', 'size', 'bytes', 'encoding'],
    )
    assert.equal(KEYSPACE_SCAN_SCHEMA[0]?.primaryKey, true)
  })
})
