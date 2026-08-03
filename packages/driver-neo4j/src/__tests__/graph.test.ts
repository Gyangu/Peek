import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isTruncatedValue } from '@peek/core'
import neo4j from 'neo4j-driver'
import {
  DEFAULT_DEPTH,
  DEFAULT_NODES,
  MAX_DEPTH,
  MAX_NODES,
  composeGraphQuery,
  graphTitle,
  quoteLabel,
  readGraphState,
} from '../graph'
import { fromNeo4jInteger, logicalTypeOf, toCell, toChunkCell } from '../values'

/**
 * The two halves of the `graph` view that never touch a server: the state a
 * plugin frame is allowed to patch, and the Cypher that state turns into.
 *
 * These are worth more than the usual unit test because of *where* the input
 * comes from. `state` is a `Record<string, unknown>` the kernel stores verbatim
 * and never inspects; it reaches `readGraphState` from a restored workspace, from
 * an MCP client, or from an iframe on another origin. This is the one boundary
 * where it becomes typed, and `composeGraphQuery` is the only thing standing
 * between it and a statement.
 */

describe('readGraphState turns an opaque bag into a state', () => {
  it('fills in defaults for a bag with nothing in it', () => {
    assert.deepEqual(readGraphState({}), { depth: DEFAULT_DEPTH, limit: DEFAULT_NODES })
  })

  it('takes the fields it recognises', () => {
    assert.deepEqual(readGraphState({ label: 'Person', depth: 2, limit: 50 }), {
      label: 'Person',
      depth: 2,
      limit: 50,
    })
  })

  it('trims a string, and treats whitespace-only as absent', () => {
    // Absent and empty are the same request — "no label filter" — and a `MATCH
    // (n:``)` built from a blank string is a syntax error rather than a wider
    // search, so the two have to converge here.
    assert.equal(readGraphState({ label: '  Person  ' }).label, 'Person')
    assert.equal(readGraphState({ label: '   ' }).label, undefined)
    assert.equal(readGraphState({ label: '' }).label, undefined)
  })

  it('clamps depth and limit into range rather than refusing them', () => {
    // Clamped, not rejected: this input arrives from a frame that may be
    // mid-drag on a slider, and an error toast per intermediate value would be
    // unusable. The ceiling is what matters, and it holds.
    assert.equal(readGraphState({ depth: 99 }).depth, MAX_DEPTH)
    assert.equal(readGraphState({ depth: 0 }).depth, 1)
    assert.equal(readGraphState({ depth: -5 }).depth, 1)
    assert.equal(readGraphState({ limit: 10_000 }).limit, MAX_NODES)
    assert.equal(readGraphState({ limit: 0 }).limit, 1)
  })

  it('truncates a fractional depth instead of interpolating it', () => {
    // `depth` is interpolated into the statement, so a `1.5` reaching Cypher
    // would be a syntax error inside `[*1..1.5]`.
    assert.equal(readGraphState({ depth: 2.9 }).depth, 2)
  })

  for (const [what, bag] of [
    ['a string where a number belongs', { depth: '3', limit: '10' }],
    ['NaN', { depth: Number.NaN, limit: Number.NaN }],
    ['Infinity', { depth: Number.POSITIVE_INFINITY, limit: Number.POSITIVE_INFINITY }],
    ['null', { depth: null, limit: null }],
    ['an object', { depth: {}, limit: [] }],
    ['a number where a string belongs', { label: 42, focus: true }],
  ] as const) {
    it(`falls back to the defaults for ${what}`, () => {
      const state = readGraphState(bag as Record<string, unknown>)
      assert.equal(state.depth, DEFAULT_DEPTH)
      assert.equal(state.limit, DEFAULT_NODES)
      assert.equal(state.label, undefined)
      assert.equal(state.focus, undefined)
    })
  }

  it('ignores keys it does not know', () => {
    // The kernel merges a patch shallowly and never removes a key it did not
    // recognise, so a frame from an older or newer build leaves debris in
    // `state`. It must be inert, not a parse failure.
    const state = readGraphState({ label: 'Person', somethingElse: { deeply: 'nested' } })
    assert.deepEqual(state, { label: 'Person', depth: DEFAULT_DEPTH, limit: DEFAULT_NODES })
  })
})

describe('quoteLabel is the escape for the one value that cannot be a parameter', () => {
  it('backticks a plain label', () => {
    assert.equal(quoteLabel('Person'), '`Person`')
  })

  it('doubles an internal backtick, which is Cypher’s own escape', () => {
    // Without the doubling the quote closes early and the remainder of the label
    // is read as Cypher. This is the whole reason the function exists.
    assert.equal(quoteLabel('we`ird'), '`we``ird`')
    assert.equal(quoteLabel('a`) MATCH (x) DETACH DELETE x //'), '`a``) MATCH (x) DETACH DELETE x //`')
  })

  it('leaves a label containing a colon alone — legal, and not a separator here', () => {
    assert.equal(quoteLabel('a:b'), '`a:b`')
  })

  it('produces a statement that stays one MATCH however the label is spelled', () => {
    const { text } = composeGraphQuery(readGraphState({ label: '`) DETACH DELETE n //' }))
    // One MATCH, one OPTIONAL MATCH, and no DELETE outside the backticks.
    assert.equal(text.match(/MATCH/g)?.length, 2)
    assert.ok(!/DELETE\s+n\s*$/m.test(text.replace(/`[^`]*`/g, '``')), 'the injection stays inside the quotes')
  })
})

describe('composeGraphQuery has three shapes and always the same two columns', () => {
  it('samples the whole graph when nothing is pinned', () => {
    const { text, params } = composeGraphQuery(readGraphState({}))
    assert.match(text, /^MATCH \(n\)/)
    assert.match(text, /RETURN n, p/)
    // Limited *before* expanding, so one hub node's edges cannot consume the
    // whole budget and be presented as a sample of the graph.
    assert.ok(text.indexOf('WITH n LIMIT') < text.indexOf('OPTIONAL MATCH'))
    assert.deepEqual(params, [DEFAULT_NODES, DEFAULT_NODES * 8])
  })

  it('filters by label, with the label quoted and the numbers still bound', () => {
    const { text, params } = composeGraphQuery(readGraphState({ label: 'Person', limit: 10 }))
    assert.match(text, /MATCH \(n:`Person`\)/)
    assert.deepEqual(params, [10, 80])
    // Everything that *can* be a parameter is one; the label is the single
    // exception and it is quoted.
    assert.ok(!text.includes('10'), 'the limit must not be inlined')
  })

  it('expands around a focus node, and the focus is a bound parameter', () => {
    const { text, params } = composeGraphQuery(readGraphState({ focus: '4:abc:7', depth: 2 }))
    assert.match(text, /elementId\(n\) = \$p1/)
    assert.match(text, /\[\*1\.\.2\]/)
    assert.equal(params[0], '4:abc:7')
  })

  it('inlines depth — and therefore clamps it — because Cypher cannot bind one', () => {
    // `[*1..$d]` does not parse, so this is the one number that becomes text.
    // The clamp is the compensation, and it is applied twice on purpose:
    // `readGraphState` bounds what is stored, this bounds what is written.
    const { text } = composeGraphQuery({ focus: '4:abc:7', depth: 99, limit: 10 })
    assert.match(text, new RegExp(`\\[\\*1\\.\\.${String(MAX_DEPTH)}\\]`))
    assert.ok(!text.includes('99'))
  })

  it('keeps the focus path OPTIONAL, so an isolated node is still a node', () => {
    // A plain MATCH would return zero rows for a node with no relationships, and
    // the view would say "nothing here" about a node the user just clicked.
    const { text } = composeGraphQuery(readGraphState({ focus: '4:abc:7' }))
    assert.match(text, /OPTIONAL MATCH p = \(n\)/)
  })

  it('focus wins over label — they are two different questions', () => {
    const { text } = composeGraphQuery(readGraphState({ label: 'Person', focus: '4:abc:7' }))
    assert.match(text, /elementId\(n\) = \$p1/)
    assert.ok(!text.includes('`Person`'))
  })

  it('bounds the edge rows separately from the node budget', () => {
    // One row per (node, incident edge): a single hub node can produce thousands
    // on its own, so without a second ceiling the node budget is spent by one
    // neighbourhood.
    const { params } = composeGraphQuery(readGraphState({ limit: 100 }))
    assert.equal(params[1], 800)
  })
})

describe('graphTitle says what the view is pointed at', () => {
  it('names the label, the focus, or nothing', () => {
    assert.equal(graphTitle(readGraphState({})), 'Graph')
    assert.equal(graphTitle(readGraphState({ label: 'Person' })), 'Graph Person')
    assert.equal(graphTitle(readGraphState({ focus: '4:abc:7' })), 'Graph 4:abc:7')
  })
})

/* ------------------------------------------------------------------ */
/* Bolt values → cells                                                 */
/* ------------------------------------------------------------------ */

const { Node, Relationship, Path, PathSegment } = neo4j.types

function node(id: string, labels: string[], props: Record<string, unknown>): InstanceType<typeof Node> {
  return new Node(neo4j.int(1), labels, props, id)
}

describe('toCell makes every Bolt value survive a structuredClone', () => {
  it('tags a node, and keeps the elementId the graph view addresses it by', () => {
    const cell = toCell(node('4:db:1', ['Person', 'Employee'], { name: 'Ada', age: neo4j.int(36) }))
    assert.deepEqual(cell, {
      _peek: 'node',
      id: '4:db:1',
      labels: ['Person', 'Employee'],
      properties: { name: 'Ada', age: 36 },
    })
    // A plain object, not a Node: the class does not survive the two clone
    // boundaries between the driver host and the window.
    assert.equal(Object.getPrototypeOf(cell), Object.prototype)
  })

  it('tags a relationship with both endpoints, so an edge can be drawn without its nodes', () => {
    const rel = new Relationship(
      neo4j.int(9),
      neo4j.int(1),
      neo4j.int(2),
      'KNOWS',
      { since: neo4j.int(2020) },
      '4:db:9',
      '4:db:1',
      '4:db:2',
    )
    assert.deepEqual(toCell(rel), {
      _peek: 'rel',
      id: '4:db:9',
      type: 'KNOWS',
      start: '4:db:1',
      end: '4:db:2',
      properties: { since: 2020 },
    })
  })

  it('flattens a path into segments the harvester can walk', () => {
    const a = node('4:db:1', ['Person'], { name: 'Ada' })
    const b = node('4:db:2', ['Person'], { name: 'Bob' })
    const rel = new Relationship(neo4j.int(9), neo4j.int(1), neo4j.int(2), 'KNOWS', {}, '4:db:9', '4:db:1', '4:db:2')
    const cell = toCell(new Path(a, b, [new PathSegment(a, rel, b)])) as {
      _peek: string
      segments: { start: { id: string }; relationship: { id: string }; end: { id: string } }[]
    }
    assert.equal(cell._peek, 'path')
    assert.equal(cell.segments.length, 1)
    assert.equal(cell.segments[0]?.start.id, '4:db:1')
    assert.equal(cell.segments[0]?.relationship.id, '4:db:9')
    assert.equal(cell.segments[0]?.end.id, '4:db:2')
  })

  it('keeps a 64-bit integer exact by becoming a string past the safe range', () => {
    // `toNumber()` past 2^53 returns a wrong number and says nothing, which is
    // the failure this rule exists to avoid.
    assert.equal(toCell(neo4j.int(42)), 42)
    assert.equal(toCell(neo4j.int('9007199254740993')), '9007199254740993')
    assert.equal(fromNeo4jInteger(neo4j.int('-9007199254740993')), '-9007199254740993')
    assert.equal(fromNeo4jInteger(neo4j.int(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
  })

  it('renders temporals and points as their own strings', () => {
    // They have faithful `toString()`s and no useful structure once the class is
    // gone, so the string is the value rather than a rendering of it.
    assert.equal(toCell(new neo4j.types.Date(2026, 8, 3)), '2026-08-03')
    assert.equal(
      toCell(new neo4j.types.Duration(neo4j.int(0), neo4j.int(1), neo4j.int(2), neo4j.int(0))),
      'P0M1DT2S',
    )
    assert.match(String(toCell(new neo4j.types.Point(neo4j.int(7203), 1, 2))), /^Point\{srid=7203/)
  })

  it('maps null and undefined to one null', () => {
    assert.equal(toCell(null), null)
    assert.equal(toCell(undefined), null)
  })

  it('recurses through arrays and maps', () => {
    assert.deepEqual(toCell([neo4j.int(1), 'x', null]), [1, 'x', null])
    assert.deepEqual(toCell({ a: neo4j.int(1), b: { c: neo4j.int(2) } }), { a: 1, b: { c: 2 } })
  })

  it('degrades an unbound relationship rather than half-building an edge', () => {
    // It arrives with no endpoints. A `rel` cell without them would send the
    // harvester looking for nodes that are not there.
    const unbound = new neo4j.types.UnboundRelationship(neo4j.int(9), 'KNOWS', { since: 2020 }, '4:db:9')
    const cell = toCell(unbound) as Record<string, unknown>
    assert.equal(cell['_peek'], undefined, 'it must not claim to be a drawable edge')
    assert.equal(cell['type'], 'KNOWS')
  })
})

describe('toChunkCell applies the long-value ceiling to leaves only', () => {
  it('truncates a long string into the shape the rest of peek already renders', () => {
    const cell = toChunkCell('x'.repeat(5000))
    assert.ok(isTruncatedValue(cell), 'a long value becomes a TruncatedValue, not a silently shortened string')
  })

  it('leaves a short string alone', () => {
    assert.equal(toChunkCell('short'), 'short')
  })

  it('does not truncate the node itself — only what is inside it', () => {
    // The recursion inside a node's properties must not shorten the node's own
    // shape, or a 300-node graph loses its structure rather than its text.
    const cell = toChunkCell(node('4:db:1', ['Person'], { bio: 'y'.repeat(5000), name: 'Ada' })) as {
      _peek: string
      properties: Record<string, unknown>
    }
    assert.equal(cell._peek, 'node')
    assert.equal(cell.properties['name'], 'Ada')
  })
})

describe('logicalTypeOf decides a column once, from the first row', () => {
  it('reads the obvious types', () => {
    assert.equal(logicalTypeOf(1), 'number')
    assert.equal(logicalTypeOf(true), 'boolean')
    assert.equal(logicalTypeOf('x'), 'string')
    assert.equal(logicalTypeOf([1, 2]), 'array')
    assert.equal(logicalTypeOf({ a: 1 }), 'json')
  })

  it('calls a null-first column unknown rather than guessing string', () => {
    // The chunk protocol pins `schema` to frame 0, so a wrong guess here is
    // wrong for the whole result set. `unknown` is the honest answer.
    assert.equal(logicalTypeOf(null), 'unknown')
    assert.equal(logicalTypeOf(undefined), 'unknown')
  })
})
