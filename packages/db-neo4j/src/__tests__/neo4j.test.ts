import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import {
  isPeekError,
  type ChunkFrame,
  type Cursor,
  type Neo4jConnectionConfig,
  type ResultId,
} from '@peek/core'
import { Neo4jSession } from '../session'

/**
 * Against a real Neo4j.
 *
 * **The suite skips itself when no server answers**, so a checkout without one
 * still runs green. Point it somewhere with:
 *
 *   PEEK_TEST_NEO4J_URL=bolt://localhost:7687 \
 *   PEEK_TEST_NEO4J_USER=neo4j PEEK_TEST_NEO4J_PASSWORD=… \
 *   pnpm --filter @peek/db-neo4j test
 *
 * A throwaway server is one line, and is what these were written against:
 *
 *   docker run -d --rm --name peek-test-neo4j -p 7687:7687 \
 *     -e NEO4J_AUTH=neo4j/peektest123 neo4j:5
 *
 * Everything it creates lives under one label and one relationship type, both
 * prefixed `PeekTest`, and both are removed afterwards. It never touches a node
 * it did not create: the whole point of this driver is that it cannot write, and
 * a test suite that reached for `MATCH (n) DETACH DELETE n` on someone's
 * development database would be a worse bug than any it could catch.
 *
 * The credentials come from the environment with no default password. Guessing
 * one is how a suite locks out the account it is trying to use — Neo4j
 * rate-limits failed auth (`Neo.ClientError.Security.AuthenticationRateLimit`),
 * so a wrong guess makes the *next*, correct attempt fail too.
 */

const URL = process.env['PEEK_TEST_NEO4J_URL'] ?? 'bolt://localhost:7687'
const USER = process.env['PEEK_TEST_NEO4J_USER'] ?? 'neo4j'
const PASSWORD = process.env['PEEK_TEST_NEO4J_PASSWORD']

const LABEL = 'PeekTestPerson'
const REL_TYPE = 'PEEK_TEST_KNOWS'

const CONFIG: Neo4jConnectionConfig = {
  driverId: 'neo4j',
  url: URL,
  user: USER,
  ...(PASSWORD === undefined ? {} : { password: PASSWORD }),
}

let session: Neo4jSession | null = null
let skipReason = ''

function rid(name: string): ResultId {
  return name as ResultId
}

/** Drain a cursor, asserting the chunk contract as frames arrive. */
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
    assert.equal(frame.seq, i, 'seq is dense from 0')
    if (i === 0) assert.ok(frame.schema, 'frame 0 carries the schema')
    else assert.equal(frame.schema, undefined, 'only frame 0 carries the schema')
    assert.equal(frame.done !== undefined, i === frames.length - 1, 'exactly one done, and it is last')
    const width = frames[0]?.schema?.length ?? 0
    if (frame.cols !== undefined) {
      assert.equal(frame.cols.length, width, 'every frame has one column per schema entry')
      for (const col of frame.cols) assert.equal(col.length, frame.rowCount, 'columns are rowCount long')
    }
  })
}

/** Rows out of a set of frames, as arrays in schema order. */
function rowsOf(frames: readonly ChunkFrame[]): unknown[][] {
  const out: unknown[][] = []
  for (const frame of frames) {
    if (frame.cols === undefined) continue
    for (let r = 0; r < frame.rowCount; r++) out.push(frame.cols.map((col) => col[r]))
  }
  return out
}

before(async () => {
  if (PASSWORD === undefined) {
    skipReason = 'PEEK_TEST_NEO4J_PASSWORD is not set'
    return
  }
  try {
    session = await Neo4jSession.connect(CONFIG)
  } catch (err) {
    skipReason = `no neo4j at ${URL}: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  // The fixture is written through the raw client rather than through the
  // session, on purpose: `Neo4jSession` opens every Bolt session read-only, so
  // it *cannot* create this — which is the property the read-only test below
  // asserts, and it would be circular to use the thing under test to set up.
  const neo4j = (await import('neo4j-driver')).default
  const driver = neo4j.driver(URL, neo4j.auth.basic(USER, PASSWORD))
  const write = driver.session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    await write.run(`MATCH (n:${LABEL}) DETACH DELETE n`)
    await write.run(
      `CREATE (a:${LABEL} {name: $a, n: 1, big: $big})
       CREATE (b:${LABEL} {name: $b, n: 2})
       CREATE (c:${LABEL} {name: $c, n: 3})
       CREATE (a)-[:${REL_TYPE} {since: 2020}]->(b)
       CREATE (b)-[:${REL_TYPE} {since: 2021}]->(c)`,
      { a: 'Ada', b: 'Bob', c: 'Cy', big: 'x'.repeat(9000) },
    )
  } finally {
    await write.close()
    await driver.close()
  }
})

after(async () => {
  await session?.close()
  if (session === null || PASSWORD === undefined) return
  const neo4j = (await import('neo4j-driver')).default
  const driver = neo4j.driver(URL, neo4j.auth.basic(USER, PASSWORD))
  const write = driver.session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    // Scoped to this suite's own label. Nothing else in the database is touched.
    await write.run(`MATCH (n:${LABEL}) DETACH DELETE n`)
  } finally {
    await write.close()
    await driver.close()
  }
})

/** Every test body starts here: it both skips and narrows the nullable session. */
function live(t: { skip: (reason?: string) => void }): Neo4jSession | null {
  if (session === null) {
    t.skip(skipReason || `no neo4j at ${URL}`)
    return null
  }
  return session
}

describe('db-neo4j against a live server', () => {
  it('reports what it connected to', (t) => {
    const s = live(t)
    if (!s) return
    assert.ok(s.capabilities.has('tabularQuery'))
  })

  it('runs Cypher and returns the columns the statement named', async (t) => {
    const s = live(t)
    if (!s) return
    const cursor = await s.query({
      resultId: rid('r_query'),
      text: `MATCH (n:${LABEL}) RETURN n.name AS name, n.n AS n ORDER BY n.n`,
    })
    const frames = await drain(cursor)
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['name', 'n'])
    assert.deepEqual(rowsOf(frames), [['Ada', 1], ['Bob', 2], ['Cy', 3]])
  })

  it('binds positional params, including the integer LIMIT takes', async (t) => {
    const s = live(t)
    if (!s) return
    // `$p2` is the case `boltParams` exists for: a plain JS number is packed as
    // a Float and Cypher refuses it here.
    const cursor = await s.query({
      resultId: rid('r_params'),
      text: `MATCH (n:${LABEL}) WHERE n.n >= $p1 RETURN n.name AS name ORDER BY n.n LIMIT $p2`,
      params: [2, 1],
    })
    assert.deepEqual(rowsOf(await drain(cursor)), [['Bob']])
  })

  it('refuses a write at the server, not in this driver', async (t) => {
    const s = live(t)
    if (!s) return
    // The property the whole read-only promise rests on: nothing inspects the
    // statement text, the server is what says no. A driver deciding for itself
    // what "looks like a write" is one `CALL apoc.*` away from being wrong, and
    // wrong silently.
    try {
      const cursor = await s.query({
        resultId: rid('r_write'),
        text: `CREATE (:${LABEL} {name: 'should not exist'})`,
      })
      await drain(cursor)
      assert.fail('a write must be refused')
    } catch (err) {
      assert.ok(isPeekError(err), 'the refusal arrives as a PeekError')
    }

    // And it really did not happen.
    const check = await s.query({
      resultId: rid('r_write_check'),
      text: `MATCH (n:${LABEL}) RETURN count(n) AS c`,
    })
    assert.deepEqual(rowsOf(await drain(check)), [[3]])
  })

  it('introspects labels and relationship types as browsable collections', async (t) => {
    const s = live(t)
    if (!s) return
    const roots = await s.listChildren(null)
    assert.ok(roots.length > 0, 'the tree has a root')
    // Walk down until a node carrying this suite's label turns up. The exact
    // shape of the tree is the driver's business; that the label is reachable
    // from the root is the contract.
    const seen = new Set<string>()
    const queue = [...roots]
    let found = false
    while (queue.length > 0 && !found) {
      const node = queue.shift()
      if (!node || seen.has(node.id)) continue
      seen.add(node.id)
      if (node.name === LABEL) {
        found = true
        break
      }
      if (node.hasChildren === true) queue.push(...(await s.listChildren(node.id)))
    }
    assert.ok(found, `${LABEL} must be reachable from the namespace root`)
  })

  it('scans a label into the two columns describeCollection promises', async (t) => {
    const s = live(t)
    if (!s) return
    const ref = { kind: 'relation' as const, schema: 'node', name: LABEL }
    const described = await s.describeCollection(ref)
    const cursor = await s.scan({ resultId: rid('r_scan'), ref, offset: 0, limit: 10 })
    const frames = await drain(cursor)
    assert.deepEqual(
      frames[0]?.schema?.map((c) => c.name),
      described.columns?.map((c) => c.name) ?? ['elementId', 'n'],
      'frame 0 delivers exactly what describeCollection promised',
    )
    assert.equal(rowsOf(frames).length, 3)
  })

  it('pages a scan without repeating or dropping a row', async (t) => {
    const s = live(t)
    if (!s) return
    const ref = { kind: 'relation' as const, schema: 'node', name: LABEL }
    const ids: unknown[] = []
    for (const offset of [0, 1, 2]) {
      const cursor = await s.scan({ resultId: rid(`r_page_${String(offset)}`), ref, offset, limit: 1 })
      const rows = rowsOf(await drain(cursor))
      assert.equal(rows.length, 1, `offset ${String(offset)} yields one row`)
      ids.push(rows[0]?.[0])
    }
    assert.equal(new Set(ids).size, 3, 'three pages, three distinct nodes')
  })

  it('scans a relationship type as well as a label', async (t) => {
    const s = live(t)
    if (!s) return
    const cursor = await s.scan({
      resultId: rid('r_rel'),
      ref: { kind: 'relation', schema: 'rel', name: REL_TYPE },
      offset: 0,
      limit: 10,
    })
    assert.equal(rowsOf(await drain(cursor)).length, 2)
  })

  it('returns a node as a tagged cell the graph view can draw', async (t) => {
    const s = live(t)
    if (!s) return
    const cursor = await s.query({
      resultId: rid('r_graph'),
      text: `MATCH (n:${LABEL} {name: 'Ada'}) OPTIONAL MATCH p = (n)-[*1..1]-() RETURN n, p`,
    })
    const rows = rowsOf(await drain(cursor))
    const first = rows[0]?.[0] as { _peek?: string; labels?: string[] } | undefined
    assert.equal(first?._peek, 'node')
    assert.ok(first?.labels?.includes(LABEL))
    const path = rows[0]?.[1] as { _peek?: string } | undefined
    assert.equal(path?._peek, 'path', 'the second column is the path the graph view harvests edges from')
  })

  it('runs the statement the graph view itself composes', async (t) => {
    const s = live(t)
    if (!s) return
    // End to end: the registration composes it, `boltParams` binds it, the
    // server runs it. This is the one test that would catch a `$pN` convention
    // drifting between `graph.ts` and `session.ts`.
    const { graphViewKind } = await import('../view')
    const fetch = graphViewKind.autoFetch({
      kind: 'package',
      packageKind: 'graph',
      connId: 'conn_1' as never,
      state: { label: LABEL, limit: 10 },
    })
    assert.ok(fetch?.capability === 'tabularQuery')
    const cursor = await s.query({
      resultId: rid('r_compose'),
      text: fetch.text,
      ...(fetch.params ? { params: [...fetch.params] } : {}),
    })
    const frames = await drain(cursor)
    assert.deepEqual(frames[0]?.schema?.map((c) => c.name), ['n', 'p'])
    assert.ok(rowsOf(frames).length >= 3)
  })

  it('truncates a long property instead of shipping nine kilobytes into a cell', async (t) => {
    const s = live(t)
    if (!s) return
    const cursor = await s.query({
      resultId: rid('r_big'),
      text: `MATCH (n:${LABEL} {name: 'Ada'}) RETURN n.big AS big`,
    })
    const cell = rowsOf(await drain(cursor))[0]?.[0]
    assert.notEqual(typeof cell, 'string', 'a 9000-character property must not arrive as a raw string')
  })

  it('reports a bad statement as a QUERY_FAILED carrying the server’s own words', async (t) => {
    const s = live(t)
    if (!s) return
    try {
      const cursor = await s.query({ resultId: rid('r_bad'), text: 'RETRUN 1' })
      await drain(cursor)
      assert.fail('a syntax error must surface')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'QUERY_FAILED')
    }
  })
})
