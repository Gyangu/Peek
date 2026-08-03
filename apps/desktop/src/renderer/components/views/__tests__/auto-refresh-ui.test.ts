import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AUTO_REFRESH_PRESETS_MS, asConnId, asResultId, asViewId, type ViewState } from '@peek/core'
import { autoRefreshMenuNodes, formatInterval } from '../autoRefreshMenu'
import { fetchShapeKey } from '../fetchShape'
import type { MenuItemNode } from '../../../ui/menuModel'

/* ==================================================================
 * The two pure halves of auto-refresh in the renderer: what the interval menu
 * offers, and when a new result set counts as a new question.
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md
 * ================================================================== */

const UNITS = { s: 's', min: ' min', h: ' h' }

const LABELS = {
  off: 'Off',
  interval: (ms: number) => formatInterval(ms, UNITS),
  stoppedNote: (reason: 'paged' | 'error') => `stopped: ${reason}`,
}

function items(nodes: ReturnType<typeof autoRefreshMenuNodes>): MenuItemNode[] {
  return nodes.filter((n): n is MenuItemNode => n.kind === 'item')
}

describe('the interval menu', () => {
  test('offers Off plus every preset, in that order', () => {
    const nodes = autoRefreshMenuNodes({ currentMs: null, labels: LABELS, onSelect: () => {} })
    const ids = items(nodes).map((n) => n.id)
    assert.deepEqual(ids, ['off', ...AUTO_REFRESH_PRESETS_MS.map((ms) => `ms-${ms}`)])
  })

  test('marks the interval in force, and only that one', () => {
    const nodes = autoRefreshMenuNodes({ currentMs: 5_000, labels: LABELS, onSelect: () => {} })
    const marked = items(nodes).filter((n) => n.label.startsWith('✓'))
    assert.equal(marked.length, 1)
    assert.equal(marked[0].id, 'ms-5000')
  })

  test('with no interval it is Off that is marked', () => {
    const nodes = autoRefreshMenuNodes({ currentMs: null, labels: LABELS, onSelect: () => {} })
    const marked = items(nodes).filter((n) => n.label.startsWith('✓'))
    assert.deepEqual(marked.map((n) => n.id), ['off'])
  })

  test('Off selects null; a preset selects its own interval', () => {
    const chosen: (number | null)[] = []
    const nodes = autoRefreshMenuNodes({
      currentMs: null,
      labels: LABELS,
      onSelect: (ms) => chosen.push(ms),
    })
    const byId = new Map(items(nodes).map((n) => [n.id, n]))
    byId.get('off')?.onSelect()
    byId.get('ms-30000')?.onSelect()
    assert.deepEqual(chosen, [null, 30_000])
  })

  test('a timer that stopped itself explains why, above everything else', () => {
    const nodes = autoRefreshMenuNodes({
      currentMs: null,
      stoppedBy: 'paged',
      labels: LABELS,
      onSelect: () => {},
    })
    assert.equal(nodes[0].kind, 'note')
    assert.equal(nodes[0].kind === 'note' ? nodes[0].text : '', 'stopped: paged')
  })

  test('with nothing to explain there is no note', () => {
    const nodes = autoRefreshMenuNodes({ currentMs: 5_000, labels: LABELS, onSelect: () => {} })
    assert.equal(nodes.some((n) => n.kind === 'note'), false)
  })
})

describe('formatting an interval', () => {
  test('seconds below a minute, minutes below an hour, hours above', () => {
    assert.equal(formatInterval(1_000, UNITS), '1s')
    assert.equal(formatInterval(30_000, UNITS), '30s')
    assert.equal(formatInterval(60_000, UNITS), '1 min')
    assert.equal(formatInterval(1_800_000, UNITS), '30 min')
    assert.equal(formatInterval(3_600_000, UNITS), '1 h')
  })

  test('every preset formats without a fraction', () => {
    for (const ms of AUTO_REFRESH_PRESETS_MS) {
      assert.match(formatInterval(ms, UNITS), /^\d+(s| min| h)$/, `${ms} formats cleanly`)
    }
  })
})

/* ------------------------------------------------------------------ */
/* Fetch shape                                                         */
/* ------------------------------------------------------------------ */

const connId = asConnId('conn_1')

function table(overrides: Partial<Extract<ViewState, { kind: 'table' }>> = {}): ViewState {
  return {
    kind: 'table',
    id: asViewId('view_1'),
    connId,
    status: 'ready',
    ref: { kind: 'relation', schema: 'public', name: 'orders' },
    page: { offset: 0, limit: 100 },
    ...overrides,
  }
}

describe('what counts as the same question', () => {
  test('a refresh keeps the shape: only the result id changed', () => {
    assert.equal(fetchShapeKey(table({ resultId: undefined })), fetchShapeKey(table()))
  })

  test('turning auto-refresh on does not itself change the shape', () => {
    // Otherwise switching the timer on would scroll the reader to the top —
    // the very thing the shape key exists to prevent.
    assert.equal(fetchShapeKey(table({ autoRefreshMs: 5_000 })), fetchShapeKey(table()))
  })

  test('paging, sorting, filtering and resizing the page are all new questions', () => {
    const base = fetchShapeKey(table())
    assert.notEqual(fetchShapeKey(table({ page: { offset: 100, limit: 100 } })), base)
    assert.notEqual(fetchShapeKey(table({ page: { offset: 0, limit: 500 } })), base)
    assert.notEqual(fetchShapeKey(table({ sort: [{ column: 'id', dir: 'asc' }] })), base)
    assert.notEqual(fetchShapeKey(table({ filter: [{ column: 'id', op: 'eq', value: 1 }] })), base)
    assert.notEqual(fetchShapeKey(table({ ref: { kind: 'relation', schema: 'public', name: 'items' } })), base)
  })

  test('a query view is shaped by its statement alone', () => {
    const base: ViewState = {
      kind: 'query',
      id: asViewId('view_2'),
      connId,
      status: 'ready',
      text: 'select 1',
    }
    assert.equal(fetchShapeKey({ ...base, resultId: undefined }), fetchShapeKey(base))
    assert.notEqual(fetchShapeKey({ ...base, text: 'select 2' }), fetchShapeKey(base))
  })

  test('a vector search is shaped by every search parameter', () => {
    const base: ViewState = {
      kind: 'vector',
      id: asViewId('view_3'),
      connId,
      status: 'ready',
      collection: 'docs',
      queryVec: [0.1, 0.2],
      topK: 10,
    }
    assert.equal(fetchShapeKey({ ...base }), fetchShapeKey(base))
    assert.notEqual(fetchShapeKey({ ...base, topK: 20 }), fetchShapeKey(base))
    assert.notEqual(fetchShapeKey({ ...base, queryVec: [0.1, 0.3] }), fetchShapeKey(base))
    assert.notEqual(fetchShapeKey({ ...base, scoreThreshold: 0.5 }), fetchShapeKey(base))
  })

  test('a view with no fetch of its own answers with its own id: never equal, always reset', () => {
    const inspector: ViewState = {
      kind: 'inspector',
      id: asViewId('view_4'),
      connId,
      status: 'ready',
      ref: { kind: 'resultCell', resultId: asResultId('result_1'), row: 0, col: 0 },
    }
    assert.equal(fetchShapeKey(inspector), fetchShapeKey({ ...inspector }))
    assert.notEqual(fetchShapeKey(inspector), fetchShapeKey({ ...inspector, id: asViewId('view_5') }))
    assert.notEqual(fetchShapeKey(inspector), fetchShapeKey(table()))
  })
})
