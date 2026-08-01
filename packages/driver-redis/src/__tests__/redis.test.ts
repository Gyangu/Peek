import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  KEYSPACE_SCAN_COLUMNS,
  isPeekError,
  isTruncatedValue,
  newResultId,
  type ChunkFrame,
  type CollectionScanRequest,
  type Cursor,
  type KeyPatternRef,
  type RedisConnectionConfig,
  type ValueRef,
} from '@peek/core'
import { createClient, type RedisClientType } from 'redis'
import { RedisSession } from '../session'

/**
 * Live tests against a real Redis.
 *
 * Isolation is by key prefix, never by database: `FLUSHDB` would take out
 * whatever else is using the same server, and a developer running these against
 * their own instance should get their data back afterwards. Everything created
 * here lives under PREFIX and is removed with SCAN + DEL — including on failure,
 * because `after` runs regardless.
 *
 * Set PEEK_TEST_REDIS_URL to point elsewhere; the suite skips itself when no
 * server answers, so a machine without redis still runs the contract tests.
 */

const URL = process.env['PEEK_TEST_REDIS_URL'] ?? 'redis://localhost:6379'
const PREFIX = 'peek:test:'
const CONFIG: RedisConnectionConfig = { driverId: 'redis', url: URL }

/** A hash big enough that one HSCAN window cannot be the whole thing */
const BIG_HASH_FIELDS = 10_000
/** Bigger than VALUE_PREVIEW_BYTES (4KB), so the scalar has to travel truncated */
const BIG_STRING_BYTES = 200_000
/** Enough keys that a scan needs several SCAN round trips */
const BULK_KEYS = 3_000

type RawClient = RedisClientType

let raw: RawClient | null = null
let session: RedisSession | null = null
let available = false

function client(): RawClient {
  if (!raw) throw new Error('no redis client')
  return raw
}

function live(): RedisSession {
  if (!session) throw new Error('no session')
  return session
}

function pattern(glob: string, db?: number): KeyPatternRef {
  return { kind: 'keyPattern', pattern: glob, ...(db === undefined ? {} : { db }) }
}

function scanRequest(over: Partial<CollectionScanRequest> & { ref: KeyPatternRef }): CollectionScanRequest {
  return { resultId: newResultId(), ...over }
}

/** Remove everything this suite created, without touching anyone else's keys */
async function purge(c: RawClient): Promise<void> {
  let cursor = '0'
  do {
    const page = await c.scan(cursor, { MATCH: `${PREFIX}*`, COUNT: 500 })
    cursor = page.cursor
    if (page.keys.length > 0) await c.del(page.keys)
  } while (cursor !== '0')
}

before(async () => {
  const c = createClient({ url: URL, disableOfflineQueue: true, socket: { reconnectStrategy: false } })
  c.on('error', () => {})
  try {
    await c.connect()
  } catch {
    try {
      c.destroy()
    } catch {
      // never connected
    }
    return
  }
  raw = c
  available = true
  await purge(c)

  await c.set(`${PREFIX}user:1:name`, 'alice')
  await c.set(`${PREFIX}user:2:name`, 'bob')
  await c.set(`${PREFIX}user:1:token`, 'tok-1', { PX: 60_000 })
  await c.hSet(`${PREFIX}user:1:profile`, { city: 'Berlin', lang: 'de' })
  await c.rPush(`${PREFIX}queue:jobs`, ['j1', 'j2', 'j3'])
  await c.sAdd(`${PREFIX}tags`, ['red', 'green', 'blue'])
  await c.zAdd(`${PREFIX}leaderboard`, [
    { value: 'alice', score: 10 },
    { value: 'bob', score: 20 },
  ])
  await c.xAdd(`${PREFIX}events`, '*', { kind: 'signup', user: 'alice' })
  await c.set(`${PREFIX}blob`, 'x'.repeat(BIG_STRING_BYTES))

  // One big hash, so the HSCAN window is provably a window
  for (let base = 0; base < BIG_HASH_FIELDS; base += 1_000) {
    const chunk: Record<string, string> = {}
    for (let i = base; i < base + 1_000; i += 1) chunk[`f${i}`] = String(i)
    await c.hSet(`${PREFIX}big:hash`, chunk)
  }
  // Bulk keys, so a scan takes several round trips and cancellation has time to land
  for (let base = 0; base < BULK_KEYS; base += 500) {
    const multi = c.multi()
    for (let i = base; i < base + 500; i += 1) multi.set(`${PREFIX}bulk:${i}`, String(i))
    await multi.exec()
  }

  session = await RedisSession.connect(CONFIG)
})

after(async () => {
  if (session) await session.close().catch(() => {})
  if (raw) {
    await purge(raw).catch(() => {})
    try {
      raw.destroy()
    } catch {
      // already gone
    }
  }
})

/* ------------------------------------------------------------------ */
/* Chunk-protocol checking                                             */
/* ------------------------------------------------------------------ */

interface Drained {
  frames: ChunkFrame[]
  rows: unknown[][]
}

/**
 * Pull a cursor dry and assert every clause of the chunk contract on the way:
 * schema on frame 0 only, contiguous seq, column widths matching rowCount,
 * exactly one `done` and it is last, and null afterwards.
 */
async function drain(cursor: Cursor): Promise<Drained> {
  const frames: ChunkFrame[] = []
  for (;;) {
    const frame = await cursor.next()
    if (frame === null) break
    frames.push(frame)
    if (frame.done) break
  }
  assert.ok(frames.length > 0, 'even an empty result set must emit one frame')

  const schema = frames[0]?.schema
  assert.ok(schema, 'frame 0 must carry the schema')
  frames.forEach((frame, i) => {
    assert.equal(frame.seq, i, 'seq starts at 0 and never skips')
    if (i > 0) assert.equal(frame.schema, undefined, 'schema rides on frame 0 only')
    assert.equal(frame.cols.length, schema.length, 'one column array per schema column')
    for (const col of frame.cols) {
      assert.equal(col.length, frame.rowCount, 'every column holds exactly rowCount values')
    }
    assert.equal(
      frame.done !== undefined,
      i === frames.length - 1,
      'done rides on the last frame and nowhere else',
    )
  })
  assert.equal(await cursor.next(), null, 'next() past the final frame is null')

  const rows: unknown[][] = []
  for (const frame of frames) {
    for (let r = 0; r < frame.rowCount; r += 1) rows.push(frame.cols.map((col) => col[r]))
  }
  const done = frames[frames.length - 1]?.done
  assert.equal(done?.rows, rows.length, 'done.rows matches the rows actually emitted')
  return { frames, rows }
}

/** Column index of a scan column inside a drained frame */
function colIndex(frame: ChunkFrame, name: string): number {
  const at = frame.schema?.findIndex((c) => c.name === name) ?? -1
  assert.ok(at >= 0, `column ${name} is missing`)
  return at
}

/* ------------------------------------------------------------------ */

describe('driver-redis against a live server', () => {
  it('connects and reports the server it is talking to', (t) => {
    if (!available) return t.skip('no redis at ' + URL)
    const s = live()
    assert.equal(s.driverId, 'redis')
    assert.deepEqual([...s.capabilities].sort(), [
      'cancel', 'collectionScan', 'introspect', 'keyValue', 'valuePeek',
    ])
    assert.match(s.serverInfo.version, /^\d+\.\d+/)
    assert.ok(s.serverInfo.flavor && s.serverInfo.flavor.length > 0)
  })

  /* ---- introspect ------------------------------------------------- */

  it('builds a namespace tree from key prefixes, lazily', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const roots = await s.listChildren(null)
    const db0 = roots.find((n) => n.id === 'db:0')
    assert.ok(db0, 'db0 is always shown')
    assert.equal(db0.kind, 'keyspace')
    assert.deepEqual(db0.ref, { kind: 'keyPattern', pattern: '*', db: 0 })

    const top = await s.listChildren('db:0')
    const peek = top.find((n) => n.name === 'peek')
    assert.ok(peek, 'the peek: prefix shows up as a group')
    assert.equal(peek.kind, 'keyPrefix')
    assert.equal(peek.hasChildren, true)
    assert.deepEqual(peek.ref, { kind: 'keyPattern', pattern: 'peek:*', db: 0 })

    const test = await s.listChildren(peek.id)
    const names = test.map((n) => n.name)
    assert.ok(names.includes('test'), 'nesting goes one segment at a time')

    const level = await s.listChildren('prefix:0:peek:test')
    const byName = new Map(level.map((n) => [n.name, n]))
    // Deeper prefixes …
    assert.equal(byName.get('user')?.kind, 'keyPrefix')
    assert.deepEqual(byName.get('user')?.ref, {
      kind: 'keyPattern', pattern: 'peek:test:user:*', db: 0,
    })
    // … and the keys that stop right here, carrying their type
    const tags = byName.get('tags')
    assert.equal(tags?.kind, 'key')
    assert.equal(tags?.hasChildren, false)
    assert.equal(tags?.detail, 'set')
    assert.deepEqual(tags?.meta, { db: 0, key: 'peek:test:tags', type: 'set' })

    // A key node is a leaf
    assert.deepEqual(await s.listChildren(`key:0:${PREFIX}tags`), [])
  })

  it('rejects a node id it did not mint, and a collection ref that is not a key pattern', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    await assert.rejects(
      () => s.listChildren('nonsense'),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => s.describeCollection({ kind: 'relation', schema: 'public', name: 't' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  it('describes a keyspace with the canonical scan schema', async (t) => {
    if (!available) return t.skip('no redis')
    const info = await live().describeCollection(pattern('*'))
    assert.deepEqual(
      info.columns.map((c) => c.name),
      ['key', 'type', 'ttlMs', 'size', 'bytes', 'encoding'],
    )
    assert.deepEqual(info.primaryKey, ['key'])
    assert.ok((info.rowCountEstimate ?? 0) >= BULK_KEYS, 'DBSIZE backs the estimate for *')

    // A narrower pattern gets no estimate: DBSIZE would be an upper bound wearing
    // the word "estimate"
    const narrow = await live().describeCollection(pattern(`${PREFIX}user:*`))
    assert.equal(narrow.rowCountEstimate, undefined)
  })

  /* ---- collectionScan --------------------------------------------- */

  it('scans a keyspace into chunk frames, one row per key', async (t) => {
    if (!available) return t.skip('no redis')
    const cursor = await live().scan(scanRequest({ ref: pattern(`${PREFIX}user:*`), limit: 100 }))
    const { frames, rows } = await drain(cursor)
    const keyAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
    const typeAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.type)
    const ttlAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.ttlMs)
    const sizeAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.size)

    const byKey = new Map(rows.map((row) => [String(row[keyAt]), row]))
    assert.equal(byKey.size, 4, 'four user: keys were created')
    assert.equal(byKey.get(`${PREFIX}user:1:name`)?.[typeAt], 'string')
    assert.equal(byKey.get(`${PREFIX}user:1:profile`)?.[typeAt], 'hash')
    assert.equal(byKey.get(`${PREFIX}user:1:profile`)?.[sizeAt], 2)
    // -1 is redis for "no expiry"; the key with PX has a real countdown
    assert.equal(byKey.get(`${PREFIX}user:2:name`)?.[ttlAt], -1)
    const ttl = byKey.get(`${PREFIX}user:1:token`)?.[ttlAt]
    assert.ok(typeof ttl === 'number' && ttl > 0 && ttl <= 60_000, `ttl looked wrong: ${ttl}`)

    // Exhausted iteration hands out no cursor: '0' would restart the scan forever
    assert.equal(frames[frames.length - 1]?.done?.nextCursor, undefined)
  })

  it('emits one frame with done for an empty result set', async (t) => {
    if (!available) return t.skip('no redis')
    const cursor = await live().scan(scanRequest({ ref: pattern(`${PREFIX}nothing-matches:*`) }))
    const { frames, rows } = await drain(cursor)
    assert.equal(rows.length, 0)
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.rowCount, 0)
    assert.equal(frames[0]?.done?.rows, 0)
  })

  it('pages a large keyspace through nextCursor, and never re-issues a spent cursor', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const seen = new Set<string>()
    let token: string | undefined
    let pages = 0
    do {
      const cursor = await s.scan(scanRequest({
        ref: pattern(`${PREFIX}bulk:*`),
        limit: 400,
        ...(token === undefined ? {} : { cursorToken: token }),
      }))
      const { frames, rows } = await drain(cursor)
      const keyAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
      for (const row of rows) seen.add(String(row[keyAt]))
      // A page is a page: SCAN pages are whatever size the server felt like, and
      // emitting the whole buffered page would overshoot the caller's limit —
      // which is what the table view labels its range with and what an MCP
      // receipt reports, so consecutive pages would overlap
      assert.ok(rows.length <= 400, `a page must not exceed the limit; got ${rows.length}`)
      assert.equal(frames[frames.length - 1]?.done?.rows, rows.length, 'done.rows is the rows emitted')
      token = frames[frames.length - 1]?.done?.nextCursor
      if (token !== undefined) assert.notEqual(token, '0', 'a spent cursor is never handed back')
      pages += 1
      assert.ok(pages < 200, 'paging must terminate')
    } while (token !== undefined)

    // SCAN may repeat a key, so rows >= keys; every key must nonetheless be seen
    assert.equal(seen.size, BULK_KEYS)
    assert.ok(pages > 1, 'the limit really did split the keyspace into pages')
  })

  /**
   * `limit` is a ceiling, not a hint.
   *
   * A SCAN page is sized by the server, so stopping the *fetch* at the ceiling is
   * not the same as stopping the *emission*: a limit of 1 used to come back with
   * a whole 500-key page. The resume point for a cut that lands inside a page is
   * the two-part continuation token (`<boundary>:<skip>`).
   */
  it('emits at most `limit` rows, whatever size the SCAN page came back', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    for (const limit of [1, 5, 50, 400, BULK_KEYS]) {
      const { frames, rows } = await drain(await s.scan(scanRequest({
        ref: pattern(`${PREFIX}bulk:*`),
        limit,
      })))
      assert.ok(rows.length <= limit, `limit ${limit}: got ${rows.length} rows`)
      assert.equal(frames[frames.length - 1]?.done?.rows, rows.length)
    }
  })

  /**
   * Paging a keyspace end to end delivers each key once, and only once.
   *
   * The interesting half is "only once": a cut mid-page has to resume *inside*
   * that page, so a resume that snapped back to the page boundary would re-deliver
   * everything between the boundary and the cut.
   */
  it('pages a keyspace with no overlap between consecutive pages', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const seen: string[] = []
    let token: string | undefined
    let pages = 0
    do {
      const { frames, rows } = await drain(await s.scan(scanRequest({
        ref: pattern(`${PREFIX}bulk:*`),
        limit: 137,
        ...(token === undefined ? {} : { cursorToken: token }),
      })))
      const keyAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
      assert.ok(rows.length <= 137, `page ${pages} had ${rows.length} rows`)
      for (const row of rows) seen.push(String(row[keyAt]))
      token = frames[frames.length - 1]?.done?.nextCursor
      pages += 1
      assert.ok(pages < 200, 'paging must terminate')
    } while (token !== undefined)

    assert.equal(new Set(seen).size, BULK_KEYS, 'every key must be seen')
    assert.equal(seen.length, BULK_KEYS, 'and no key twice')
    assert.ok(pages > 1, 'the limit really did split the keyspace into pages')
  })

  it('pushes a type filter into SCAN and applies the rest client-side', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const typed = await s.scan(scanRequest({
      ref: pattern(`${PREFIX}*`),
      filter: [{ column: 'type', op: 'eq', value: 'zset' }],
      limit: 1_000,
    }))
    const zsets = await drain(typed)
    const keyAt = colIndex(zsets.frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
    assert.deepEqual(zsets.rows.map((r) => r[keyAt]), [`${PREFIX}leaderboard`])

    // `contains` has no server-side equivalent and must still be honoured
    const contained = await s.scan(scanRequest({
      ref: pattern(`${PREFIX}*`),
      filter: [{ column: 'key', op: 'contains', value: 'leaderboard' }],
      limit: 5_000,
    }))
    const hits = await drain(contained)
    const hitKeyAt = colIndex(hits.frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
    assert.deepEqual(hits.rows.map((r) => r[hitKeyAt]), [`${PREFIX}leaderboard`])
  })

  it('projects the scan schema, and rejects a column that does not exist', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const cursor = await s.scan(scanRequest({
      ref: pattern(`${PREFIX}tags`),
      columns: ['key', 'type'],
    }))
    const { frames } = await drain(cursor)
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['key', 'type'])

    await assert.rejects(
      () => s.scan(scanRequest({ ref: pattern('*'), columns: ['nope'] })),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  it('refuses a native filter and a sort instead of quietly ignoring them', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    await assert.rejects(
      () => s.scan(scanRequest({ ref: pattern('*'), nativeFilter: { must: [] } })),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => s.scan(scanRequest({ ref: pattern('*'), sort: [{ column: 'key', dir: 'asc' }] })),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => s.scan(scanRequest({ ref: pattern('*'), cursorToken: 'not-a-cursor' })),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  it('never issues KEYS — the server itself is the witness', async (t) => {
    if (!available) return t.skip('no redis')
    const c = client()
    try {
      await c.configResetStat()
    } catch {
      return t.skip('CONFIG RESETSTAT is not permitted on this server')
    }
    const s = live()
    await drain(await s.scan(scanRequest({ ref: pattern(`${PREFIX}*`), limit: 5_000 })))
    await s.listChildren('db:0')
    await s.listChildren('prefix:0:peek:test')

    const stats = await c.info('commandstats')
    assert.doesNotMatch(stats, /^cmdstat_keys:/m, 'KEYS blocks the server and is never allowed')
    assert.match(stats, /^cmdstat_scan:/m, 'browsing goes through SCAN')
  })

  /**
   * A denied metadata command degrades one column, it does not kill the scan.
   *
   * `MEMORY USAGE` and `OBJECT ENCODING` are routinely forbidden on ElastiCache,
   * Upstash and any restricted ACL, and the default keyspace projection asks for
   * both — so "every element of this batch was rejected" is the *ordinary* state
   * of a managed redis, not evidence of a broken socket. Injected here rather
   * than by creating an ACL user, because this suite does not reconfigure a
   * server it does not own.
   */
  it('degrades a denied metadata command to null instead of failing the scan', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    // The client map is private on purpose; a test is the one caller allowed to
    // reach past it, because there is no other way to make a live server refuse
    // exactly one command
    const clients = (s as unknown as {
      clients: Map<number, Promise<{ memoryUsage: unknown }>>
    }).clients
    const conn = await [...clients.values()][0]
    assert.ok(conn, 'the session holds a client for its default database')
    const original = conn.memoryUsage
    let calls = 0
    conn.memoryUsage = (): Promise<never> => {
      calls += 1
      return Promise.reject(
        new Error("NOPERM User peektest has no permissions to run the 'memory|usage' command"),
      )
    }
    try {
      const { frames, rows } = await drain(await s.scan(scanRequest({
        ref: pattern(`${PREFIX}bulk:*`),
        limit: 400,
        chunkRows: 100,
      })))
      assert.equal(rows.length, 400, 'the scan still delivers its page')
      const bytesAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.bytes)
      assert.ok(rows.every((r) => r[bytesAt] === null), 'the refused column degrades to null')
      const typeAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.type)
      assert.ok(rows.every((r) => r[typeAt] === 'string'), 'the columns that work still work')
      // Latched off after the first wholly-refused batch: re-issuing one doomed
      // command per key for every remaining page is pure waste
      assert.ok(calls > 0, 'it really was attempted')
      assert.ok(calls <= 500, `a denied command must not be retried per key forever; ${calls} calls`)
    } finally {
      conn.memoryUsage = original
    }
  })

  /* ---- cancel ------------------------------------------------------ */

  it('cancels a running scan, and says so instead of ending quietly', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const resultId = newResultId()
    const cursor = await s.scan(scanRequest({
      resultId,
      ref: pattern(`${PREFIX}bulk:*`),
      limit: 5_000,
      chunkRows: 50,
    }))
    const first = await cursor.next()
    assert.ok(first, 'the scan produced a frame before the cancel')
    assert.equal(first.done, undefined, 'the scan was still running')

    assert.equal(await s.cancel(resultId), true)
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.code === 'CANCELLED',
    )
    // Cancelling twice is not an error, it is just false
    assert.equal(await s.cancel(resultId), false)
    assert.equal(await s.cancel(newResultId()), false)
  })

  it('stops a scan on an AbortSignal', async (t) => {
    if (!available) return t.skip('no redis')
    const ac = new AbortController()
    const cursor = await live().scan(scanRequest({
      ref: pattern(`${PREFIX}bulk:*`),
      limit: 5_000,
      chunkRows: 50,
      signal: ac.signal,
    }))
    assert.ok(await cursor.next())
    ac.abort()
    await assert.rejects(
      () => cursor.next(),
      (err: unknown) => isPeekError(err) && err.code === 'CANCELLED',
    )
  })

  /* ---- keyValue ---------------------------------------------------- */

  it('dispatches getValue on the redis type, one shape per type', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const get = (key: string): Promise<Awaited<ReturnType<RedisSession['getValue']>>> =>
      s.getValue({ kind: 'redisValue', key })

    const str = await get(`${PREFIX}user:1:name`)
    assert.equal(str.type, 'string')
    assert.deepEqual(str.value, { shape: 'scalar', value: 'alice' })
    assert.equal(str.size, 5, 'a string reports its byte length as its size')
    assert.equal(str.ttlMs, -1)
    assert.equal(str.encoding, 'embstr')
    assert.ok((str.byteSize ?? 0) > 0)

    const hash = await get(`${PREFIX}user:1:profile`)
    assert.equal(hash.type, 'hash')
    assert.equal(hash.value.shape, 'map')
    if (hash.value.shape === 'map') {
      const fields = new Map(hash.value.fields.map((f) => [f.field, f.value]))
      assert.equal(fields.get('city'), 'Berlin')
      assert.equal(fields.get('lang'), 'de')
    }

    const list = await get(`${PREFIX}queue:jobs`)
    assert.equal(list.type, 'list')
    assert.deepEqual(list.value, { shape: 'list', start: 0, items: ['j1', 'j2', 'j3'] })

    const set = await get(`${PREFIX}tags`)
    assert.equal(set.type, 'set')
    assert.equal(set.value.shape, 'set')
    if (set.value.shape === 'set') {
      assert.deepEqual([...set.value.members].sort(), ['blue', 'green', 'red'])
    }

    const zset = await get(`${PREFIX}leaderboard`)
    assert.equal(zset.type, 'zset')
    assert.deepEqual(zset.value, {
      shape: 'sortedSet',
      entries: [{ member: 'alice', score: 10 }, { member: 'bob', score: 20 }],
    })

    const stream = await get(`${PREFIX}events`)
    assert.equal(stream.type, 'stream')
    assert.equal(stream.value.shape, 'stream')
    if (stream.value.shape === 'stream') {
      assert.equal(stream.value.entries.length, 1)
      assert.deepEqual(
        stream.value.entries[0]?.fields,
        [{ field: 'kind', value: 'signup' }, { field: 'user', value: 'alice' }],
      )
    }

    // A key that is not there is `missing`, not an error: it expiring between the
    // scan and the click is ordinary
    const gone = await get(`${PREFIX}definitely-not-here`)
    assert.equal(gone.type, 'none')
    assert.deepEqual(gone.value, { shape: 'missing' })
  })

  it('windows a 10,000-field hash through HSCAN instead of HGETALL', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const ref: ValueRef = { kind: 'redisValue', key: `${PREFIX}big:hash` }

    const first = await s.getValue(ref, { limit: 100 })
    assert.equal(first.size, BIG_HASH_FIELDS, 'size reports the whole hash')
    assert.equal(first.truncated, true, 'the window is not the whole thing')
    assert.ok(first.nextCursor !== undefined, 'more can be fetched')
    assert.equal(first.value.shape, 'map')
    const windowSize = first.value.shape === 'map' ? first.value.fields.length : 0
    assert.ok(windowSize > 0 && windowSize < BIG_HASH_FIELDS, `window was ${windowSize}`)

    // Walk the whole hash through the cursor; every field must show up exactly once
    const seen = new Set<string>()
    let token: string | undefined
    let rounds = 0
    do {
      const page = await s.getValue(ref, { limit: 500, ...(token === undefined ? {} : { cursorToken: token }) })
      if (page.value.shape === 'map') for (const f of page.value.fields) seen.add(f.field)
      token = page.nextCursor
      rounds += 1
      assert.ok(rounds < 500, 'the hash walk must terminate')
    } while (token !== undefined)
    assert.equal(seen.size, BIG_HASH_FIELDS)
    assert.ok(rounds > 1, 'a 10k hash really did take more than one window')

    // MATCH is pushed into HSCAN. It filters *after* COUNT elements have been
    // scanned, so a single window legitimately comes back empty — the pattern is
    // still honoured across the whole iteration, which is what this walks.
    const matched: string[] = []
    let matchToken: string | undefined
    do {
      const page = await s.getValue(ref, {
        limit: 1_000,
        match: 'f42',
        ...(matchToken === undefined ? {} : { cursorToken: matchToken }),
      })
      if (page.value.shape === 'map') for (const f of page.value.fields) matched.push(f.field)
      matchToken = page.nextCursor
    } while (matchToken !== undefined)
    assert.deepEqual(matched, ['f42'])
  })

  it('windows a list and a sorted set by index', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const list = await s.getValue({ kind: 'redisValue', key: `${PREFIX}queue:jobs` }, {
      offset: 1,
      limit: 1,
    })
    assert.deepEqual(list.value, { shape: 'list', start: 1, items: ['j2'] })
    assert.equal(list.truncated, true)
    assert.equal(list.nextCursor, '2')

    const zset = await s.getValue({ kind: 'redisValue', key: `${PREFIX}leaderboard` }, { limit: 1 })
    assert.deepEqual(zset.value, { shape: 'sortedSet', entries: [{ member: 'alice', score: 10 }] })
    assert.equal(zset.nextCursor, '1')
  })

  it('addresses one element through ValueRef.path, keeping the key shape', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const field = await s.getValue({
      kind: 'redisValue', key: `${PREFIX}user:1:profile`, path: 'city',
    })
    assert.equal(field.type, 'hash')
    assert.deepEqual(field.value, { shape: 'map', fields: [{ field: 'city', value: 'Berlin' }] })
    assert.equal(field.truncated, true, 'one field of two is not the whole hash')

    const item = await s.getValue({ kind: 'redisValue', key: `${PREFIX}queue:jobs`, path: '2' })
    assert.deepEqual(item.value, { shape: 'list', start: 2, items: ['j3'] })

    const member = await s.getValue({ kind: 'redisValue', key: `${PREFIX}tags`, path: 'red' })
    assert.deepEqual(member.value, { shape: 'set', members: ['red'] })

    const scored = await s.getValue({ kind: 'redisValue', key: `${PREFIX}leaderboard`, path: 'bob' })
    assert.deepEqual(scored.value, { shape: 'sortedSet', entries: [{ member: 'bob', score: 20 }] })

    await assert.rejects(
      () => s.getValue({ kind: 'redisValue', key: `${PREFIX}user:1:profile`, path: 'nope' }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  it('refuses a ValueRef minted for another driver', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    await assert.rejects(
      () => s.getValue({ kind: 'qdrantPoint', collection: 'c', pointId: 1, field: 'vector' }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
  })

  /* ---- valuePeek --------------------------------------------------- */

  it('truncates a large string in the inspector and serves the rest through valuePeek', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const ref: ValueRef = { kind: 'redisValue', key: `${PREFIX}blob` }

    const value = await s.getValue(ref)
    assert.equal(value.truncated, true)
    assert.equal(value.value.shape, 'scalar')
    const scalar = value.value.shape === 'scalar' ? value.value.value : ''
    assert.ok(isTruncatedValue(scalar), 'a 200KB string travels as a preview')
    if (isTruncatedValue(scalar)) {
      assert.equal(scalar.preview.length, 4 * 1024, 'cut at VALUE_PREVIEW_BYTES')
      assert.equal(scalar.byteLength, BIG_STRING_BYTES, 'STRLEN, not the preview length')
      // The ref names the database explicitly, so it still resolves after the
      // inspector is reopened against a session whose default db moved
      assert.deepEqual(scalar.ref, { kind: 'redisValue', key: `${PREFIX}blob`, db: 0 })
    }

    const whole = await s.peekValue(ref)
    assert.equal(whole.encoding, 'utf8')
    assert.equal(whole.contentType, 'text/plain')
    assert.equal(whole.totalBytes, BIG_STRING_BYTES)
    assert.equal(whole.byteLength, BIG_STRING_BYTES)
    assert.equal(whole.eof, true)

    const window = await s.peekValue(ref, { offset: 10, length: 20 })
    assert.equal(window.byteLength, 20)
    assert.equal(window.data, 'x'.repeat(20))
    assert.equal(window.totalBytes, BIG_STRING_BYTES)
    assert.equal(window.eof, false)

    const tail = await s.peekValue(ref, { offset: BIG_STRING_BYTES - 5, length: 100 })
    assert.equal(tail.byteLength, 5)
    assert.equal(tail.eof, true)
  })

  it('peeks a single element of a container, and refuses to peek a container whole', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const field = await s.peekValue({
      kind: 'redisValue', key: `${PREFIX}user:1:profile`, path: 'city',
    })
    assert.equal(field.data, 'Berlin')
    assert.equal(field.eof, true)
    assert.equal(field.totalBytes, 6)

    const item = await s.peekValue({ kind: 'redisValue', key: `${PREFIX}queue:jobs`, path: '0' })
    assert.equal(item.data, 'j1')

    // "The whole hash" is a structure, not a value; getValue's window reads it
    await assert.rejects(
      () => s.peekValue({ kind: 'redisValue', key: `${PREFIX}user:1:profile` }),
      (err: unknown) => isPeekError(err) && err.code === 'BAD_REQUEST',
    )
    await assert.rejects(
      () => s.peekValue({ kind: 'redisValue', key: `${PREFIX}not-a-key` }),
      (err: unknown) => isPeekError(err) && err.code === 'NOT_FOUND',
    )
  })

  it('labels a JSON value as JSON and binary bytes as base64', async (t) => {
    if (!available) return t.skip('no redis')
    const c = client()
    const s = live()
    await c.set(`${PREFIX}doc`, JSON.stringify({ a: [1, 2, 3] }))
    const json = await s.peekValue({ kind: 'redisValue', key: `${PREFIX}doc` })
    assert.equal(json.encoding, 'json')
    assert.equal(json.contentType, 'application/json')

    // A byte string that is not valid UTF-8 must not be mangled into replacement chars
    await c.set(`${PREFIX}bin`, Buffer.from([0xff, 0xfe, 0x00, 0x41]))
    const bin = await s.peekValue({ kind: 'redisValue', key: `${PREFIX}bin` })
    assert.equal(bin.encoding, 'base64')
    assert.equal(bin.contentType, 'application/octet-stream')
    assert.deepEqual([...Buffer.from(bin.data, 'base64')], [0xff, 0xfe, 0x00, 0x41])
  })

  /* ---- multiple logical databases ---------------------------------- */

  it('reaches another logical database without SELECTing the shared client', async (t) => {
    if (!available) return t.skip('no redis')
    const s = live()
    const other = createClient({ url: URL, database: 1, socket: { reconnectStrategy: false } })
    other.on('error', () => {})
    await other.connect()
    try {
      await other.set(`${PREFIX}in-db-one`, 'yes')
      const cursor = await s.scan(scanRequest({ ref: pattern(`${PREFIX}in-db-one`, 1) }))
      const { frames, rows } = await drain(cursor)
      const keyAt = colIndex(frames[0] as ChunkFrame, KEYSPACE_SCAN_COLUMNS.key)
      assert.deepEqual(rows.map((r) => r[keyAt]), [`${PREFIX}in-db-one`])

      const value = await s.getValue({ kind: 'redisValue', key: `${PREFIX}in-db-one`, db: 1 })
      assert.deepEqual(value.value, { shape: 'scalar', value: 'yes' })

      // db0 is untouched by any of that
      const inDb0 = await s.getValue({ kind: 'redisValue', key: `${PREFIX}in-db-one` })
      assert.deepEqual(inDb0.value, { shape: 'missing' })
    } finally {
      await purge(other).catch(() => {})
      try {
        other.destroy()
      } catch {
        // already gone
      }
    }
  })
})
