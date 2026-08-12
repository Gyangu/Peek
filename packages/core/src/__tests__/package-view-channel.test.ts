import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PACKAGE_MAX_ROWS, parsePackageViewClientMessage } from '../index'

/* ==================================================================
 * What a package frame is allowed to say — design 2026-08-07 §4.4 item 19.
 *
 * `parsePackageViewClientMessage` is the entire inbound half of the front-end
 * boundary (§2.1): a Tier C view has no preload, no network, and one
 * MessagePort, so this function is the only thing between a package's own
 * JavaScript and the window. Until this file existed it had **no assertion
 * anywhere** — three production call sites and nothing that had ever fed it a
 * message it must refuse, which is the shape of a boundary that is documented
 * rather than held.
 *
 * The claim under test is narrow and worth stating exactly: a frame can change
 * **its own view's state** and say nothing else. In particular it cannot hand
 * the host a statement to run, under any spelling, which is why every refusal
 * below carries a query in it.
 *
 * Reverse verification for this file is `.replace()`-free: drop any member of
 * the discriminated union in `package-view-channel.ts` and the accepted-shape
 * tests go red; widen `PackageViewClientMessageSchema` with a `text` or `query`
 * member and `refuses anything that carries a statement` goes red.
 * ================================================================== */

/** One statement, spelled the way a package author would spell it. */
const STATEMENT = 'MATCH (n) DETACH DELETE n'

describe('the port accepts exactly three shapes', () => {
  it('takes the handshake', () => {
    assert.deepEqual(parsePackageViewClientMessage({ t: 'ready' }), { t: 'ready' })
  })

  it('takes a state patch, which is the only thing a frame may change', () => {
    const message = parsePackageViewClientMessage({
      t: 'patch',
      state: { selectedNodeId: '42', layout: 'force' },
      title: 'Graph',
    })
    assert.deepEqual(message, {
      t: 'patch',
      state: { selectedNodeId: '42', layout: 'force' },
      title: 'Graph',
    })
  })

  it('takes a patch with neither field, because both are optional', () => {
    // `{ t: 'patch' }` is a no-op the host still dispatches; it is legal, and
    // saying so here stops a future `.min(1)` from arriving without a decision.
    assert.deepEqual(parsePackageViewClientMessage({ t: 'patch' }), { t: 'patch' })
  })

  it('takes the frame reporting its own trouble', () => {
    assert.deepEqual(parsePackageViewClientMessage({ t: 'error', message: 'layout worker died' }), {
      t: 'error',
      message: 'layout worker died',
    })
  })
})

describe('the port refuses anything that carries a statement', () => {
  /*
   * The acceptance item names `text` and `query`; every plausible spelling of
   * "run this" is here, because the property is not about two field names — it
   * is that **no member of the union has a place to put one**. A frame that
   * wanted to be executed would have to invent a discriminant, and there is no
   * discriminant to invent.
   */
  const REFUSED: readonly unknown[] = [
    { t: 'query', query: STATEMENT },
    { t: 'query', text: STATEMENT },
    { t: 'run', text: STATEMENT, connId: 'conn_1' },
    { t: 'execute', statement: STATEMENT },
    { t: 'command', command: 'query.run', params: { text: STATEMENT } },
    { t: 'fetchMore', cursor: 'abc' },
    { t: 'view.open', kind: 'table' },
  ]

  for (const message of REFUSED) {
    it(`drops ${JSON.stringify(message)}`, () => {
      assert.equal(parsePackageViewClientMessage(message), null)
    })
  }

  it('does not let a statement ride along on a patch', () => {
    // The one that would pass a naive reading of the schema: `t` is a member, so
    // the message parses — and the extra keys are **stripped**, so what the host
    // gets has no `query` and no `text` in it. Asserting the exact object rather
    // than "is not null" is the whole point: `deepEqual` fails if either key
    // survives, which is what a `.passthrough()` or a hand-rolled cast would do.
    const message = parsePackageViewClientMessage({
      t: 'patch',
      state: { layout: 'force' },
      query: STATEMENT,
      text: STATEMENT,
      connId: 'conn_1',
    })
    assert.deepEqual(message, { t: 'patch', state: { layout: 'force' } })
  })

  it('leaves a query inside `state` alone, and that is not a hole', () => {
    // `state` is `Record<string, unknown>` and stays that way: it is the
    // package's own view state, opaque to peek, and a package that wants a
    // `query` key in it is describing its own UI to itself. What makes this
    // safe is not the schema but where composition happens — the *statement* is
    // built by the package's registration, which runs in main (§2.1), and
    // `PackageFrame` forwards this through `view.update` like any other control.
    // Pinned here so that a future reader looking for the hole finds the reason
    // instead of the field.
    assert.deepEqual(parsePackageViewClientMessage({ t: 'patch', state: { query: STATEMENT } }), {
      t: 'patch',
      state: { query: STATEMENT },
    })
  })
})

describe('the port refuses its own other direction', () => {
  /*
   * Host → frame messages are not client messages. A frame that echoes back what
   * it was sent must not be believed: `data` carries rows and `init` carries the
   * view's identity, and either one accepted here would be the host reading its
   * own output as input.
   */
  it('drops a host `init`', () => {
    assert.equal(
      parsePackageViewClientMessage({
        t: 'init',
        viewId: 'view_1',
        packageKind: 'neo4j.graph',
        state: {},
        locale: 'en',
        theme: 'dark',
      }),
      null,
    )
  })

  it('drops a host `data`', () => {
    assert.equal(
      parsePackageViewClientMessage({
        t: 'data',
        status: 'done',
        columns: ['n'],
        rows: [[1]],
        rowCount: 1,
        truncated: false,
      }),
      null,
    )
  })

  it('drops a host `state` and a host `theme`', () => {
    assert.equal(parsePackageViewClientMessage({ t: 'state', state: {} }), null)
    assert.equal(parsePackageViewClientMessage({ t: 'theme', theme: 'dark' }), null)
  })
})

describe('the port refuses malformed messages without throwing', () => {
  /*
   * Null rather than a throw is load-bearing: `PackageFrame` drops the message
   * and keeps the view alive, and an exception escaping `onmessage` would take
   * the window's event handler with it. Every entry here is something a broken
   * package sends by accident, and `structuredClone` lets all of them cross.
   */
  const MALFORMED: readonly unknown[] = [
    null,
    undefined,
    'ready',
    42,
    true,
    [],
    ['patch'],
    {},
    { t: 'PATCH' },
    { t: 'patch ' },
    { patch: {} },
    { t: null },
    new Date(0),
  ]

  for (const message of MALFORMED) {
    it(`drops ${String(JSON.stringify(message) ?? message)}`, () => {
      assert.equal(parsePackageViewClientMessage(message), null)
    })
  }

  it('refuses a patch whose fields are the wrong type', () => {
    assert.equal(parsePackageViewClientMessage({ t: 'patch', title: 42 }), null)
    assert.equal(parsePackageViewClientMessage({ t: 'patch', state: 'force' }), null)
    assert.equal(parsePackageViewClientMessage({ t: 'patch', state: [1, 2] }), null)
  })

  it('refuses an error report longer than the schema allows', () => {
    // The 2000-char bound is the only size limit on this channel. A frame that
    // can push unbounded text into the error centre has a denial-of-attention
    // primitive, so the bound is a property and not a formatting preference.
    assert.deepEqual(parsePackageViewClientMessage({ t: 'error', message: 'x'.repeat(2000) }), {
      t: 'error',
      message: 'x'.repeat(2000),
    })
    assert.equal(parsePackageViewClientMessage({ t: 'error', message: 'x'.repeat(2001) }), null)
  })

  it('refuses an error with no message at all', () => {
    assert.equal(parsePackageViewClientMessage({ t: 'error' }), null)
  })
})

describe('the row cap is a constant both sides read', () => {
  it('is the bound `PackageFrame` reports its viewport against', () => {
    // Not a style assertion: the frame's viewport is `[0, PACKAGE_MAX_ROWS - 1]`,
    // so a cap that drifted from what the host will send is a view that asks for
    // rows nobody will produce or stops asking before the snapshot ends.
    assert.equal(PACKAGE_MAX_ROWS, 2000)
  })
})
