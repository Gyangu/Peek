import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  isPeekError,
  filterTarget,
  isTruncatedValue,
  resolveCollectionBrowseStyle,
  type ChunkFrame,
  type Cursor,
  type ResultId,
} from '@peek/core'
import { buildRowShape, pointToRow } from '../points'
import { QdrantSession } from '../session'

/**
 * Live tests against a real Qdrant.
 *
 * They **create and drop one collection of their own**, `peek_test_vectors`, and
 * touch nothing else — a developer's qdrant usually holds real collections and a
 * test suite has no business writing to them.
 *
 * The whole suite skips when no server answers, so a checkout without qdrant
 * still runs green; point `PEEK_TEST_QDRANT_URL` elsewhere to use another one.
 */

const URL = process.env['PEEK_TEST_QDRANT_URL'] ?? 'http://localhost:6333'
const COLLECTION = 'peek_test_vectors'

let reachable = false
let session: QdrantSession | null = null

/** Result ids are branded; tests mint their own without going through the id module */
function rid(name: string): ResultId {
  return name as ResultId
}

async function rest(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function restOk(method: string, path: string, body?: unknown): Promise<void> {
  const res = await rest(method, path, body)
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
  }
}

/** Drain a cursor, asserting the chunk contract as frames arrive */
async function drain(cursor: Cursor): Promise<ChunkFrame[]> {
  const frames: ChunkFrame[] = []
  for (;;) {
    const frame = await cursor.next()
    if (frame === null) break
    frames.push(frame)
    if (frame.done) break
  }
  assertChunkContract(frames)
  return frames
}

/**
 * core/chunk.ts, verbatim: schema on frame 0 only, seq dense from 0, exactly one
 * `done` and it is last, every column as long as rowCount.
 */
function assertChunkContract(frames: readonly ChunkFrame[]): void {
  assert.ok(frames.length > 0, 'even an empty result set emits one frame')
  frames.forEach((frame, i) => {
    assert.equal(frame.seq, i, 'seq increments from 0 with no gaps')
    if (i === 0) assert.ok(frame.schema !== undefined, 'frame 0 carries the schema')
    else assert.equal(frame.schema, undefined, 'later frames never repeat the schema')
    const width = frames[0]?.schema?.length ?? 0
    assert.equal(frame.cols.length, width)
    for (const col of frame.cols) assert.equal(col.length, frame.rowCount)
    assert.equal(frame.done !== undefined, i === frames.length - 1, 'only the last frame is done')
  })
}

async function expectPeekError(fn: () => Promise<unknown>): Promise<{ code: string; message: string; key?: string }> {
  try {
    await fn()
  } catch (err) {
    assert.ok(isPeekError(err), `expected a PeekError, got ${String(err)}`)
    return { code: err.code, message: err.message, ...(err.i18n ? { key: err.i18n.key } : {}) }
  }
  throw new assert.AssertionError({ message: 'expected a failure' })
}

const BIG_TEXT = 'x'.repeat(9000)

before(async () => {
  try {
    const probe = await rest('GET', '/')
    reachable = probe.ok
  } catch {
    reachable = false
  }
  if (!reachable) return

  // Two named vectors on purpose: the single-vector case is what every other
  // qdrant test uses, and the named case is where vectorName has to be enforced
  await rest('DELETE', `/collections/${COLLECTION}`)
  await restOk('PUT', `/collections/${COLLECTION}`, {
    vectors: { title: { size: 4, distance: 'Cosine' }, body: { size: 3, distance: 'Dot' } },
  })
  await restOk('PUT', `/collections/${COLLECTION}/index?wait=true`, {
    field_name: 'lang',
    field_schema: 'keyword',
  })
  await restOk('PUT', `/collections/${COLLECTION}/index?wait=true`, {
    field_name: 'n',
    field_schema: 'integer',
  })
  await restOk('PUT', `/collections/${COLLECTION}/points?wait=true`, {
    points: [
      { id: 1, vector: { title: [1, 0, 0, 0], body: [1, 0, 0] }, payload: { lang: 'en', n: 1, blob: BIG_TEXT } },
      { id: 2, vector: { title: [0.9, 0.1, 0, 0], body: [0, 1, 0] }, payload: { lang: 'en', n: 2, blob: 'short' } },
      { id: 3, vector: { title: [0, 1, 0, 0], body: [0, 0, 1] }, payload: { lang: 'zh', n: 3 } },
      { id: 4, vector: { title: [0, 0, 1, 0], body: [1, 1, 0] }, payload: { lang: 'zh', n: 4, nested: { a: 1 } } },
    ],
  })
  session = await QdrantSession.connect({ driverId: 'qdrant', url: URL })
})

after(async () => {
  await session?.close()
  if (reachable) await rest('DELETE', `/collections/${COLLECTION}`)
})

/** Every test body starts here: it both skips and narrows the nullable session */
function live(t: { skip: (reason?: string) => void }): QdrantSession | null {
  if (session === null) {
    t.skip(`no qdrant at ${URL}`)
    return null
  }
  return session
}

describe('driver-qdrant row shape', () => {
  it('disambiguates a payload key that collides with a reserved column name', () => {
    // Mirroring the primary key into the payload is extremely common, and two
    // columns called `id` would leave the grid unable to tell them apart
    const shape = buildRowShape({
      payloadColumns: ['id', 'score', 'lang'],
      withScore: true,
      withVector: false,
    })
    assert.deepEqual(shape.columns.map((c) => c.name), ['id', 'score', 'id__2', 'score__2', 'lang'])
    // The payload keys themselves are untouched: they are what the lookup uses
    assert.deepEqual([...shape.payloadColumns], ['id', 'score', 'lang'])

    const row = pointToRow({ id: 7, payload: { id: 'abc', score: 3, lang: 'en' } }, shape)
    assert.deepEqual(row, [7, null, 'abc', 3, 'en'])
  })

  it('drops the columns a point does not carry rather than shifting the row', () => {
    const shape = buildRowShape({ payloadColumns: ['a', 'b'], withScore: false, withVector: false })
    assert.deepEqual(pointToRow({ id: 'u1', payload: { b: 2 } }, shape), ['u1', null, 2])
    assert.deepEqual(pointToRow({ id: 'u2' }, shape), ['u2', null, null])
  })
})

describe('driver-qdrant against a live server', () => {
  it('reports the server version and the qdrant flavor', (t) => {
    const s = live(t)
    if (!s) return
    assert.equal(s.serverInfo.flavor, 'Qdrant')
    assert.match(s.serverInfo.version, /^\d+\.\d+/)
  })

  it('lists collections at the root and their structure one level down', async (t) => {
    const s = live(t)
    if (!s) return
    const roots = await s.listChildren(null)
    const node = roots.find((n) => n.name === COLLECTION)
    assert.ok(node, 'the test collection shows up at the root')
    assert.equal(node.kind, 'collection')
    assert.deepEqual(node.ref, { kind: 'vectorCollection', collection: COLLECTION })
    assert.match(node.detail ?? '', /4 points/)

    const children = await s.listChildren(node.id)
    const names = children.map((c) => c.name)
    assert.deepEqual(names, ['body', 'title', 'lang', 'n'])
    // Vector nodes and payload-index nodes are informational: neither is browsable
    for (const child of children) {
      assert.equal(child.ref, undefined)
      assert.equal(child.hasChildren, false)
    }
    assert.equal(children[1]?.detail, '4d · Cosine')
  })

  it('rejects an unrecognized node id instead of returning an empty level', async (t) => {
    const s = live(t)
    if (!s) return
    const err = await expectPeekError(() => s.listChildren('nonsense'))
    assert.equal(err.code, 'BAD_REQUEST')
    assert.equal(err.key, 'error.introspect.unknownNodeId')
  })

  it('describes a collection with the schema its scan will actually produce', async (t) => {
    const s = live(t)
    if (!s) return
    const info = await s.describeCollection({ kind: 'vectorCollection', collection: COLLECTION })
    assert.deepEqual(info.columns.map((c) => c.name), ['id', 'payload'])
    assert.deepEqual(info.primaryKey, ['id'])
    assert.equal(info.rowCountEstimate, 4)
    assert.equal(info.comment, 'body: 3d · Dot, title: 4d · Cosine')
    // Payload indexes are reported as indexes, not folded into the columns: the
    // frame-0 schema must not depend on mutable server-side index state
    assert.deepEqual(info.indexes?.map((i) => i.columns[0]), ['lang', 'n'])

    // The per-collection browse style, which the kind-keyed table could not
    // express: `order_by` needs a payload index, so *these two keys* are the
    // orderable ones and everything else in the payload is not
    const style = resolveCollectionBrowseStyle(info.ref, info.browse)
    assert.equal(style.sortable, true)
    assert.deepEqual(style.sortableColumns, ['lang', 'n'])
    assert.equal(style.offsetPaging, false, 'a scroll has no numeric offset')
    assert.equal(style.sortEndsPaging, true, 'an ordered scroll has no continuation')
  })

  /**
   * Which result column a filter may be attached to — the gesture the frame-0
   * schema could not support.
   *
   * `FilterSpec.column` on a vector collection has always meant a **payload
   * key**, while the default result schema is `id` plus one opaque json
   * `payload`. So the key being filtered on was not among the result columns at
   * all, and "click a column header to filter" had nowhere to land. Now the
   * filter says which it means (`FilterTarget`), and the browse style says which
   * headers may offer the control.
   */
  it('says which result columns a filter may target, and refuses the payload blob', async (t) => {
    const s = live(t)
    if (!s) return
    const info = await s.describeCollection({ kind: 'vectorCollection', collection: COLLECTION })
    const style = resolveCollectionBrowseStyle(info.ref, info.browse)
    // The default projection: only the point id is filterable. A predicate over
    // the payload blob as a whole is not something qdrant can express.
    assert.deepEqual(style.filterableColumns, ['id'])

    // A payload key that was not projected is a *field*, not a column, and goes
    // through untouched — this is what every MCP caller writes
    assert.equal(filterTarget({ column: 'lang', op: 'eq', value: 'en' }, ['id', 'payload']), 'field')
    assert.equal(filterTarget({ column: 'id', op: 'eq', value: 1 }, ['id', 'payload']), 'column')

    // Saying "the column called payload" is refused rather than silently read as
    // a payload key called "payload"
    const err = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-filter-blob'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        filter: [{ column: 'payload', op: 'eq', value: 'x', target: 'column' }],
      }),
    )
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /payload/)

    // Project the key into a column of its own and the header becomes real: the
    // same predicate is now a legitimate column filter
    const frames = await drain(
      await s.scan({
        resultId: rid('t-filter-projected'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        columns: ['lang'],
        filter: [{ column: 'lang', op: 'eq', value: 'en', target: 'column' }],
        limit: 10,
      }),
    )
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'lang'])
    assert.ok((frames.at(-1)?.done?.rows ?? 0) > 0, 'the projected-column filter still selects rows')

    // And a column that is not in the result at all is a hard error, because a
    // header click cannot produce one
    const missing = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-filter-missing'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        filter: [{ column: 'nope', op: 'eq', value: 1, target: 'column' }],
      }),
    )
    assert.equal(missing.code, 'BAD_REQUEST')
  })

  /**
   * The refusal the UI can now predict.
   *
   * `blob` is a payload key with no index, so qdrant answers `order_by` on it
   * with a 400 — which used to surface as a QUERY_FAILED from the server, after
   * the round trip, with no hint about which keys *would* have worked. The
   * declared browse style turns it into a BAD_REQUEST that names them.
   */
  it('refuses an order by a payload key that has no index, and says which keys do', async (t) => {
    const s = live(t)
    if (!s) return
    const err = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-sort-unindexed'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'blob', dir: 'asc' }],
      }),
    )
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /blob/)
    assert.match(err.message, /lang, n/, 'the refusal has to say what would have worked')
  })

  it('scrolls without ever fetching a vector body', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({ resultId: rid('t-scan'), ref: { kind: 'vectorCollection', collection: COLLECTION }, limit: 10 }),
    )
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'payload'])
    assert.equal(frames.at(-1)?.done?.rows, 4)
    assert.deepEqual(frames[0]?.cols[0], [1, 2, 3, 4], 'numeric point ids stay numeric')
    // The whole collection fits in one page, so there is nothing to continue
    assert.equal(frames.at(-1)?.done?.nextCursor, undefined)
    // No vector column at all — the body is reachable only through valuePeek
    assert.equal(frames[0]?.schema?.some((c) => c.name === 'vector'), false)
  })

  it('cuts a large payload down to a preview plus a ref back to the point', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({ resultId: rid('t-big'), ref: { kind: 'vectorCollection', collection: COLLECTION }, limit: 10 }),
    )
    const cell = frames[0]?.cols[1]?.[0]
    assert.ok(isTruncatedValue(cell), 'a 9KB payload cannot travel in a chunk')
    assert.ok((cell.byteLength ?? 0) > 9000)
    assert.ok(cell.preview.length < 5000)
    assert.deepEqual(cell.ref, {
      kind: 'qdrantPoint',
      collection: COLLECTION,
      pointId: 1,
      // The reserved 'payload:' with an empty key addresses the payload object itself
      field: 'payload:',
    })
    // The small payloads came through whole
    assert.deepEqual(frames[0]?.cols[1]?.[2], { lang: 'zh', n: 3 })
  })

  it('pages with nextCursor, resuming exactly where the previous page stopped', async (t) => {
    const s = live(t)
    if (!s) return
    const first = await drain(
      await s.scan({ resultId: rid('t-p1'), ref: { kind: 'vectorCollection', collection: COLLECTION }, limit: 2 }),
    )
    assert.deepEqual(first[0]?.cols[0], [1, 2])
    const token = first.at(-1)?.done?.nextCursor
    assert.ok(token !== undefined, 'a full page hands back a continuation')
    // A page boundary is paging, not truncation — same as the relational drivers
    assert.equal(first.at(-1)?.done?.truncated, undefined)

    const second = await drain(
      await s.scan({
        resultId: rid('t-p2'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        limit: 2,
        cursorToken: token,
        // offset is ignored when a cursorToken is present (the core contract)
        offset: 999,
      }),
    )
    assert.deepEqual(second[0]?.cols[0], [3, 4])
    assert.equal(second.at(-1)?.done?.nextCursor, undefined, 'the last page has no continuation')
  })

  it('emulates a numeric offset, and refuses one that would cost a scroll of the world', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-off'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        offset: 2,
        limit: 10,
      }),
    )
    assert.deepEqual(frames[0]?.cols[0], [3, 4])

    const err = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-off2'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        offset: 5_000_000,
      }),
    )
    assert.equal(err.code, 'BAD_REQUEST')
  })

  it('emits one done frame for an empty result set', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-empty'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        filter: [{ column: 'lang', op: 'eq', value: 'nope' }],
        limit: 10,
      }),
    )
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.rowCount, 0)
    assert.equal(frames[0]?.done?.rows, 0)
    assert.deepEqual(frames[0]?.cols, [[], []])
  })

  it('splits a page into several frames without repeating the schema', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-chunk'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        limit: 10,
        chunkRows: 2,
      }),
    )
    assert.equal(frames.length, 2)
    assert.deepEqual(frames.map((f) => f.rowCount), [2, 2])
  })

  it('flattens payload keys into columns only when asked', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-flat'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        columns: ['lang', 'n', 'absent'],
        limit: 10,
      }),
    )
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'lang', 'n', 'absent'])
    assert.deepEqual(frames[0]?.cols[1], ['en', 'en', 'zh', 'zh'])
    assert.deepEqual(frames[0]?.cols[2], [1, 2, 3, 4])
    // A key no point carries is a column of nulls, not a missing column
    assert.deepEqual(frames[0]?.cols[3], [null, null, null, null])
  })

  it('translates the portable filters into qdrant conditions', async (t) => {
    const s = live(t)
    if (!s) return
    const ids = async (filter: Parameters<typeof s.scan>[0]['filter']): Promise<unknown[]> => {
      const frames = await drain(
        await s.scan({
          resultId: rid(`t-f-${Math.random().toString(36).slice(2)}`),
          ref: { kind: 'vectorCollection', collection: COLLECTION },
          ...(filter === undefined ? {} : { filter }),
          limit: 10,
        }),
      )
      return frames[0]?.cols[0] ?? []
    }
    assert.deepEqual(await ids([{ column: 'lang', op: 'eq', value: 'zh' }]), [3, 4])
    assert.deepEqual(await ids([{ column: 'lang', op: 'neq', value: 'zh' }]), [1, 2])
    assert.deepEqual(await ids([{ column: 'n', op: 'gte', value: 3 }]), [3, 4])
    assert.deepEqual(await ids([{ column: 'n', op: 'in', value: [1, 4] }]), [1, 4])
    // The id column is not payload: it becomes has_id
    assert.deepEqual(await ids([{ column: 'id', op: 'in', value: [2, 3] }]), [2, 3])
    assert.deepEqual(await ids([{ column: 'id', op: 'eq', value: 2 }]), [2])
    // "has no value" covers both of qdrant's readings, missing and explicit null
    assert.deepEqual(await ids([{ column: 'nested', op: 'isNotNull' }]), [4])
    assert.deepEqual(await ids([{ column: 'nested', op: 'isNull' }]), [1, 2, 3])
    // Several specs are ANDed, like every other driver
    assert.deepEqual(
      await ids([{ column: 'lang', op: 'eq', value: 'zh' }, { column: 'n', op: 'gt', value: 3 }]),
      [4],
    )
  })

  it('passes a native filter through, and refuses one it cannot read', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-native'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        nativeFilter: { must: [{ key: 'lang', match: { value: 'en' } }] },
        limit: 10,
      }),
    )
    assert.deepEqual(frames[0]?.cols[0], [1, 2])

    // Silently ignoring an unreadable filter would return more points than the
    // caller asked for, with no way to notice — so it is a hard failure
    for (const bad of ['lang = en', { where: 1 }, {}, 42, null]) {
      const err = await expectPeekError(() =>
        s.scan({
          resultId: rid('t-native-bad'),
          ref: { kind: 'vectorCollection', collection: COLLECTION },
          nativeFilter: bad,
        }),
      )
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })

  it('orders a scroll by one payload key, and refuses what the server cannot do', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.scan({
        resultId: rid('t-sort'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'n', dir: 'desc' }],
        limit: 10,
      }),
    )
    assert.deepEqual(frames[0]?.cols[0], [4, 3, 2, 1])
    // An ordered scroll has no id-based continuation
    assert.equal(frames.at(-1)?.done?.nextCursor, undefined)

    const multi = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-sort2'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'n', dir: 'asc' }, { column: 'lang', dir: 'asc' }],
      }),
    )
    assert.equal(multi.code, 'BAD_REQUEST')

    const paged = await expectPeekError(() =>
      s.scan({
        resultId: rid('t-sort3'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'n', dir: 'asc' }],
        cursorToken: '2',
      }),
    )
    assert.equal(paged.code, 'BAD_REQUEST')
  })

  /**
   * An ordered scroll cut short by `limit` has to *say* it was cut short.
   *
   * A scroll normally reports a page boundary with `nextCursor` alone — a page
   * boundary is paging, not truncation. But `order_by` has no id-based
   * continuation, so there is no cursor to carry that fact: without the flag a
   * `done` that stopped at 2 of 4 points would be byte-identical to one that
   * reached the end, and a consumer (or a model reading an MCP receipt) would
   * conclude the collection holds two points.
   */
  it('flags an ordered scroll that stopped at the limit, since no cursor can say so', async (t) => {
    const s = live(t)
    if (!s) return
    const short = await drain(
      await s.scan({
        resultId: rid('t-sort-cut'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'n', dir: 'desc' }],
        limit: 2,
      }),
    )
    const cut = short.at(-1)?.done
    assert.equal(cut?.rows, 2)
    assert.equal(cut?.nextCursor, undefined, 'an ordered scroll has no continuation to offer')
    assert.equal(cut?.truncated, true, 'so the flag is the only thing left to say it was cut')

    const whole = await drain(
      await s.scan({
        resultId: rid('t-sort-whole'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        sort: [{ column: 'n', dir: 'desc' }],
        limit: 100,
      }),
    )
    assert.equal(whole.at(-1)?.done?.truncated, undefined, 'and a complete one must not raise it')

    // The unordered case is unchanged: `nextCursor` already carries the same fact,
    // so a page boundary stays paging rather than truncation
    const page = await drain(
      await s.scan({
        resultId: rid('t-page-cut'),
        ref: { kind: 'vectorCollection', collection: COLLECTION },
        limit: 2,
      }),
    )
    assert.equal(page.at(-1)?.done?.truncated, undefined)
    assert.ok(page.at(-1)?.done?.nextCursor, 'because the cursor says it')
  })

  it('searches by an existing point and returns a score column', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.vectorSearch({
        resultId: rid('t-search'),
        collection: COLLECTION,
        queryPointId: 1,
        vectorName: 'title',
        topK: 3,
        columns: ['lang'],
      }),
    )
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'score', 'lang'])
    // "more like this" ranks point 2 first and leaves the reference point out
    assert.equal(frames[0]?.cols[0]?.[0], 2)
    const best = frames[0]?.cols[1]?.[0]
    assert.equal(typeof best, 'number')
    assert.ok((best as number) > 0.9)
    // topK bounds the whole result: a search has no continuation to hand back
    assert.equal(frames.at(-1)?.done?.nextCursor, undefined)
  })

  it('searches by a literal vector, honouring scoreThreshold and withVector', async (t) => {
    const s = live(t)
    if (!s) return
    const frames = await drain(
      await s.vectorSearch({
        resultId: rid('t-search2'),
        collection: COLLECTION,
        queryVec: [1, 0, 0, 0],
        vectorName: 'title',
        topK: 4,
        scoreThreshold: 0.5,
        withVector: true,
      }),
    )
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['id', 'score', 'payload', 'vector'])
    assert.deepEqual(frames[0]?.cols[0], [1, 2], 'the two far vectors fall below the threshold')
    assert.deepEqual(frames[0]?.cols[3]?.[0], [1, 0, 0, 0])
  })

  it('refuses a search it cannot answer rather than guessing', async (t) => {
    const s = live(t)
    if (!s) return
    const base = { resultId: rid('t-bad'), collection: COLLECTION, topK: 2 } as const

    // The driver never embeds text: no vector means no search
    const none = await expectPeekError(() => s.vectorSearch({ ...base, vectorName: 'title' }))
    assert.equal(none.key, 'error.vector.queryRequired')
    const both = await expectPeekError(() =>
      s.vectorSearch({ ...base, vectorName: 'title', queryVec: [1, 0, 0, 0], queryPointId: 1 }),
    )
    assert.equal(both.key, 'error.vector.queryRequired')

    // A multi-vector collection has no default vector, and qdrant's own message
    // does not say what the names are
    const unnamed = await expectPeekError(() => s.vectorSearch({ ...base, queryPointId: 1 }))
    assert.equal(unnamed.key, 'error.vector.nameRequired')
    assert.match(unnamed.message, /body, title/)

    const wrongName = await expectPeekError(() =>
      s.vectorSearch({ ...base, queryPointId: 1, vectorName: 'nope' }),
    )
    assert.equal(wrongName.key, 'error.vector.nameUnknown')

    // Caught before the request goes out
    const dims = await expectPeekError(() =>
      s.vectorSearch({ ...base, queryVec: [1, 2], vectorName: 'title' }),
    )
    assert.equal(dims.key, 'error.vector.dimensionMismatch')

    const gone = await expectPeekError(() =>
      s.vectorSearch({ ...base, queryPointId: 9999, vectorName: 'title' }).then(drain),
    )
    assert.equal(gone.key, 'error.vector.pointNotFound')
    assert.equal(gone.code, 'NOT_FOUND')
  })

  it('peeks a vector body, a payload key and the whole payload', async (t) => {
    const s = live(t)
    if (!s) return
    const vector = await s.peekValue({
      kind: 'qdrantPoint',
      collection: COLLECTION,
      pointId: 1,
      field: 'vector:title',
    })
    assert.equal(vector.encoding, 'json')
    assert.equal(vector.contentType, 'application/json')
    assert.deepEqual(JSON.parse(vector.data), [1, 0, 0, 0])
    assert.equal(vector.eof, true)

    const blob = await s.peekValue({
      kind: 'qdrantPoint',
      collection: COLLECTION,
      pointId: 1,
      field: 'blob',
    })
    assert.equal(blob.encoding, 'utf8')
    assert.equal(blob.contentType, 'text/plain')
    assert.equal(blob.totalBytes, 9000)
    assert.equal(blob.data, BIG_TEXT)

    const whole = await s.peekValue({
      kind: 'qdrantPoint',
      collection: COLLECTION,
      pointId: 3,
      field: 'payload:',
    })
    assert.deepEqual(JSON.parse(whole.data), { lang: 'zh', n: 3 })
  })

  it('honours a byte range on a peek', async (t) => {
    const s = live(t)
    if (!s) return
    const ref = { kind: 'qdrantPoint', collection: COLLECTION, pointId: 1, field: 'blob' } as const
    const head = await s.peekValue(ref, { offset: 0, length: 100 })
    assert.equal(head.byteLength, 100)
    assert.equal(head.totalBytes, 9000)
    assert.equal(head.eof, false)

    const tail = await s.peekValue(ref, { offset: 8900, length: 500 })
    assert.equal(tail.byteLength, 100)
    assert.equal(tail.eof, true)
  })

  it('names the missing thing when a point or a collection is gone', async (t) => {
    const s = live(t)
    if (!s) return
    const point = await expectPeekError(() =>
      s.peekValue({ kind: 'qdrantPoint', collection: COLLECTION, pointId: 4242, field: 'blob' }),
    )
    assert.equal(point.key, 'error.vector.pointNotFound')

    const collection = await expectPeekError(() =>
      s.describeCollection({ kind: 'vectorCollection', collection: 'peek_test_does_not_exist' }),
    )
    assert.equal(collection.key, 'error.collection.notFound')
    assert.equal(collection.code, 'NOT_FOUND')
  })

  it('refuses another driver\'s refs instead of half-answering', async (t) => {
    const s = live(t)
    if (!s) return
    const ref = await expectPeekError(() => s.peekValue({ kind: 'redisValue', key: 'k' }))
    assert.equal(ref.code, 'BAD_REQUEST')

    const scan = await expectPeekError(() =>
      s.scan({ resultId: rid('t-rel'), ref: { kind: 'relation', schema: 'public', name: 't' } }),
    )
    assert.equal(scan.key, 'error.collection.kindUnsupported')
  })

  it('refuses to start two result sets with the same id', async (t) => {
    const s = live(t)
    if (!s) return
    const ref = { kind: 'vectorCollection', collection: COLLECTION } as const
    const first = await s.scan({ resultId: rid('t-dup'), ref, limit: 1 })
    const err = await expectPeekError(() => s.scan({ resultId: rid('t-dup'), ref, limit: 1 }))
    assert.equal(err.key, 'error.query.alreadyRunning')
    await first.close()
    // Closing frees the id again
    await (await s.scan({ resultId: rid('t-dup'), ref, limit: 1 })).close()
  })

  it('stops a cursor on an aborted signal, and never emits done afterwards', async (t) => {
    const s = live(t)
    if (!s) return
    const controller = new AbortController()
    const cursor = await s.scan({
      resultId: rid('t-abort'),
      ref: { kind: 'vectorCollection', collection: COLLECTION },
      limit: 10,
      signal: controller.signal,
    })
    controller.abort()
    const err = await expectPeekError(() => cursor.next())
    assert.equal(err.code, 'CANCELLED')
    // The error branch is terminal: no `done` frame can follow it
    assert.equal(await cursor.next(), null)
  })

  it('returns null forever once the stream ended', async (t) => {
    const s = live(t)
    if (!s) return
    const cursor = await s.scan({
      resultId: rid('t-after-done'),
      ref: { kind: 'vectorCollection', collection: COLLECTION },
      limit: 10,
    })
    await drain(cursor)
    assert.equal(await cursor.next(), null)
    await cursor.close()
    await cursor.close()
  })
})
