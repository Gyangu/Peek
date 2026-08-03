import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPeekError, validateViewKindRegistration, type ConnId, type ViewId } from '@peek/core'
import neo4j from 'neo4j-driver'
import { neo4jDriver, requireNeo4jConfig } from '../driver'
import { neo4jManifest } from '../manifest'
import {
  NODE_NAMESPACE,
  REL_NAMESPACE,
  boltParams,
  nodeId,
  parseNodeId,
  requireNeo4jCollection,
} from '../session'
import { GRAPH_VIEW_KIND, graphViewKind } from '../view'

/**
 * Contract tests: no Neo4j server involved. They pin what the rest of the system
 * depends on — the advertised capability set, how a collection is addressed, the
 * node-id codec, the positional-parameter convention, and the `graph` view's
 * registration — so the implementation cannot drift away from them.
 */

describe('driver-neo4j contract', () => {
  it('advertises exactly the capability set this package declares for itself', () => {
    // Against the package's own manifest, which is what the connect dialog and
    // the MCP tools read before anything has connected — one array, not two that
    // agree today.
    assert.deepEqual([...neo4jDriver.capabilities].sort(), [...neo4jManifest.capabilities].sort())
    assert.equal(neo4jDriver.meta.id, 'neo4j')
    assert.equal(neo4jDriver.meta.displayName, neo4jManifest.displayName)
  })

  it('claims `cancel`, and that claim is Bolt RESET rather than a hope', () => {
    // The qdrant driver deliberately does *not* advertise this, because aborting
    // an HTTP request stops the client reading and leaves the server working.
    // Bolt has an out-of-band reset, so here the claim is honourable — and a
    // capability advertised without an implementation is a button that lies.
    assert.equal(neo4jDriver.capabilities.has('cancel'), true)
  })

  it('has no sqlDialect, because Cypher is not a SQL dialect', () => {
    // Absent means "no SQL surface at all", not "use the standard dialect". A
    // `RETURN` highlighted as if it were a `SELECT` implies a grammar that will
    // not parse.
    assert.equal(neo4jManifest.sqlDialect, undefined)
  })

  it('rejects a config routed to the wrong driver', () => {
    assert.equal(requireNeo4jConfig({ driverId: 'neo4j', url: 'neo4j://localhost:7687' }).driverId, 'neo4j')
    try {
      requireNeo4jConfig({ driverId: 'redis', url: 'redis://localhost:6379' })
      assert.fail('a redis config must not be accepted')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })

  it('carries no credential in the MCP connect example', () => {
    // It is read verbatim by every connected client.
    assert.ok(!/password/i.test(neo4jManifest.mcpConnectExample))
  })
})

describe('a neo4j collection is a label or a relationship type', () => {
  it('reads both namespaces', () => {
    const label = requireNeo4jCollection({ kind: 'relation', schema: NODE_NAMESPACE, name: 'Person' })
    assert.equal(label.namespace, NODE_NAMESPACE)
    assert.equal(label.name, 'Person')
    assert.equal(label.variable, 'n')

    const relType = requireNeo4jCollection({ kind: 'relation', schema: REL_NAMESPACE, name: 'KNOWS' })
    assert.equal(relType.namespace, REL_NAMESPACE)
    assert.equal(relType.variable, 'r')
  })

  it('refuses an unknown namespace by name rather than picking one', () => {
    // Picking one would answer a question about labels with a page of
    // relationships. A wrong answer is worse than a refusal.
    try {
      requireNeo4jCollection({ kind: 'relation', schema: 'public', name: 'Person' })
      assert.fail('an unknown namespace must be refused')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
      assert.match(err.message, /node|rel/)
    }
  })

  it('refuses a ref of another shape', () => {
    try {
      requireNeo4jCollection({ kind: 'keyPattern', pattern: 'user:*' })
      assert.fail('a redis-shaped ref must be refused')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })
})

describe('the namespace-tree node id codec round-trips', () => {
  it('round-trips every kind', () => {
    assert.deepEqual(parseNodeId(nodeId.database('neo4j')), { kind: 'database', name: 'neo4j' })
    assert.deepEqual(parseNodeId(nodeId.group(NODE_NAMESPACE)), { kind: 'group', namespace: 'node' })
    assert.deepEqual(parseNodeId(nodeId.label('Person')), { kind: 'label', name: 'Person' })
    assert.deepEqual(parseNodeId(nodeId.relType('KNOWS')), { kind: 'relType', name: 'KNOWS' })
  })

  it('keeps a colon inside a name, because a label may contain one', () => {
    // ``CREATE (:`a:b`)`` is legal Cypher. The tag is enough to know where the
    // name starts, so the rest is taken verbatim — same rule as the redis and
    // qdrant codecs.
    assert.deepEqual(parseNodeId(nodeId.label('a:b')), { kind: 'label', name: 'a:b' })
    assert.deepEqual(parseNodeId(nodeId.relType('X:Y:Z')), { kind: 'relType', name: 'X:Y:Z' })
  })

  it('calls anything else unknown instead of throwing', () => {
    // These ids come back from a renderer that may have been persisted by
    // another version; an exception here would take a tree down.
    assert.deepEqual(parseNodeId(''), { kind: 'unknown' })
    assert.deepEqual(parseNodeId('nocolon'), { kind: 'unknown' })
    assert.deepEqual(parseNodeId('label:'), { kind: 'unknown' })
    assert.deepEqual(parseNodeId('whatever:x'), { kind: 'unknown' })
  })
})

describe('boltParams maps positional params the way both statement paths spell them', () => {
  it('numbers from 1, matching the $pN in composed Cypher', () => {
    const out = boltParams(['a', 'b'])
    assert.deepEqual(Object.keys(out), ['p1', 'p2'])
    assert.equal(out['p1'], 'a')
  })

  it('makes an integer an Integer, which is what LIMIT $pN needs to run at all', () => {
    // The client packs a JS `number` as a Bolt Float, and Cypher refuses a Float
    // where it wants an integer — `SKIP`/`LIMIT` answer "'200.0' is not a valid
    // value". That fails the whole statement, not just the paging.
    const out = boltParams([100])
    assert.ok(neo4j.isInt(out['p1']), 'a safe integer must be converted')
    assert.equal(String(out['p1']), '100')
  })

  it('leaves a fractional number a float, because it is one', () => {
    assert.equal(neo4j.isInt(boltParams([1.5])['p1']), false)
  })

  it('converts inside an array, since IN $p1 takes a list', () => {
    const list = boltParams([[1, 2]])['p1'] as unknown[]
    assert.ok(list.every((v) => neo4j.isInt(v)))
  })

  it('passes strings, booleans and null through untouched', () => {
    const out = boltParams(['x', true, null])
    assert.deepEqual([out['p1'], out['p2'], out['p3']], ['x', true, null])
  })

  it('is empty for no params, rather than absent', () => {
    assert.deepEqual(boltParams([]), {})
  })
})

describe('the graph view kind is a registration the kernel will accept', () => {
  const view = {
    id: 'view_1' as ViewId,
    kind: 'plugin' as const,
    pluginKind: GRAPH_VIEW_KIND,
    connId: 'conn_1' as ConnId,
    state: { label: 'Person', depth: 2 },
  }

  it('passes the loader’s own validation, field for field', () => {
    // The compensation for the compile-time exhaustiveness a plugin kind cannot
    // have: this is the check that runs instead, and a registration that fails
    // it does not load.
    assert.equal(validateViewKindRegistration(graphViewKind), null)
  })

  it('declares which drivers it is for, so it is not offered on a redis connection', () => {
    assert.deepEqual([...graphViewKind.driverIds], ['neo4j'])
  })

  it('describes itself in English, because MCP reads that string', () => {
    const described = graphViewKind.describe(view)
    assert.match(described, /Neo4j graph/)
    assert.match(described, /Person/)
  })

  it('always asks for a fetch — an unpinned graph is a sample, not an empty view', () => {
    const fetch = graphViewKind.autoFetch({ ...view, state: {} })
    assert.ok(fetch !== null, 'null would mean there is nothing to ask for, and there is')
    assert.equal(fetch.capability, 'tabularQuery')
    assert.ok(fetch.capability === 'tabularQuery' && fetch.text.includes('RETURN n, p'))
  })

  it('composes the statement itself, which is why a frame cannot', () => {
    // The whole safety story for a self-drawn view: the iframe patches `state`,
    // and *this* function — package code running in main — turns it into Cypher.
    const fetch = graphViewKind.autoFetch({ ...view, state: { focus: '4:db:7' } })
    assert.ok(fetch?.capability === 'tabularQuery')
    assert.match(fetch.text, /elementId\(n\) = \$p1/)
    assert.deepEqual([...(fetch.params ?? [])].slice(0, 1), ['4:db:7'])
  })

  it('claims no CollectionRef, because a graph is not one of the three shapes core models', () => {
    // Claiming one would switch on collection-shaped affordances that address
    // something this view is not looking at.
    assert.equal(graphViewKind.collectionRef(view), null)
  })

  it('names a message key rather than deriving one', () => {
    assert.equal(graphViewKind.titleKey, 'view.kind.graph')
    assert.equal(graphViewKind.kind, 'graph')
  })
})
