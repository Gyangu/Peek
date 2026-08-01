import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asConnId, asResultId, asViewId, type ViewState } from '@peek/core'
import { boundT, translate, type TFunction } from '../../../i18n'
import {
  RESULT_ATTACHMENT_MAX_ROWS,
  collectionRefOf,
  contextActionsFor,
  rowsAttachment,
  type ContextActionId,
  type ContextTarget,
} from '../descriptors'
import { CONSENT_VERSION, hasContextConsent, grantContextConsent, revokeContextConsent, resetContextConsentCache } from '../consent'
import { detailFor, type AttachmentStatus } from '../chipDetail'

/* ==================================================================
 * What can be attached from a given place in the UI. Pure, so the
 * menu and any keyboard path cannot end up offering different things.
 * ================================================================== */

// The real English translator, so a missing catalog key shows up in these
// assertions as the raw key rather than passing silently.
const t: TFunction = boundT('en')

const VIEW = asViewId('view_1')
const CONN = asConnId('conn_1')
const RESULT = asResultId('res_1')

const queryView: ViewState = { id: VIEW, kind: 'query', status: 'ready', connId: CONN, text: 'select 1' }
const tableView: ViewState = {
  id: VIEW,
  kind: 'table',
  status: 'ready',
  connId: CONN,
  ref: { kind: 'relation', schema: 'public', name: 'orders' },
  page: { offset: 0, limit: 200 },
}
const vectorView: ViewState = {
  id: VIEW,
  kind: 'vector',
  status: 'ready',
  connId: CONN,
  collection: 'docs',
  topK: 10,
}
const treeView: ViewState = { id: VIEW, kind: 'tree', status: 'ready', connId: CONN, expanded: [] }

const ids = (target: ContextTarget): ContextActionId[] => contextActionsFor(target, t).map((a) => a.id)

describe('contextActionsFor · what is offered', () => {
  it('always offers the workspace, even with nothing else around', () => {
    assert.deepEqual(ids({ view: treeView }), ['workspace'])
  })

  it('offers the query text only on a query view', () => {
    assert.ok(ids({ view: queryView }).includes('query'))
    assert.ok(!ids({ view: tableView }).includes('query'))
  })

  it('offers the structure of a browsed collection, but not of an ad-hoc projection', () => {
    // A query view produced its own columns; there is no single table to describe,
    // and guessing which one the SQL meant is not something a menu should do.
    assert.ok(ids({ view: tableView }).includes('schema'))
    assert.ok(ids({ view: vectorView }).includes('schema'))
    assert.ok(!ids({ view: queryView }).includes('schema'))
  })

  it('offers rows only when rows are selected', () => {
    assert.ok(!ids({ view: tableView, resultId: RESULT }).includes('rows'))
    assert.ok(ids({ view: tableView, resultId: RESULT, selectedRows: [1, 2] }).includes('rows'))
  })

  it('offers nothing result-shaped without a result', () => {
    const out = ids({ view: tableView, selectedRows: [1], cell: { rowIndex: 1, column: 'a' } })
    assert.ok(!out.includes('rows'))
    assert.ok(!out.includes('result'))
    assert.ok(!out.includes('cell'))
  })

  it('omits what is unavailable rather than offering it disabled', () => {
    // A greyed-out entry tells the user nothing they can act on.
    const out = contextActionsFor({ view: treeView }, t)
    assert.equal(out.length, 1)
  })

  it('orders by specificity: the thing pointed at first, its container after', () => {
    const out = ids({
      view: tableView,
      resultId: RESULT,
      selectedRows: [3],
      cell: { rowIndex: 3, column: 'city' },
    })
    assert.deepEqual(out, ['cell', 'rows', 'result', 'schema', 'workspace'])
  })
})

describe('contextActionsFor · the descriptors it builds', () => {
  it('builds a rows descriptor carrying the exact selection', () => {
    const action = contextActionsFor(
      { view: tableView, resultId: RESULT, selectedRows: [9, 2, 5] },
      t,
    ).find((a) => a.id === 'rows')
    const built = action?.build()
    assert.equal(built?.kind, 'rows')
    if (built?.kind !== 'rows') return
    assert.deepEqual(built.rowIndexes, [2, 5, 9], 'sorted and de-duplicated for a stable reading order')
    assert.equal(built.resultId, RESULT)
    assert.equal(built.viewId, VIEW)
  })

  it('caps a whole-result attachment at a page rather than the entire set', () => {
    const built = contextActionsFor({ view: tableView, resultId: RESULT }, t)
      .find((a) => a.id === 'result')
      ?.build()
    assert.equal(built?.kind, 'result')
    if (built?.kind !== 'result') return
    assert.equal(built.maxRows, RESULT_ATTACHMENT_MAX_ROWS)
  })

  it('builds a cell descriptor addressing the row and column by name', () => {
    const built = contextActionsFor(
      { view: tableView, resultId: RESULT, cell: { rowIndex: 7, column: 'email' } },
      t,
    )
      .find((a) => a.id === 'cell')
      ?.build()
    assert.equal(built?.kind, 'cell')
    if (built?.kind !== 'cell') return
    assert.equal(built.rowIndex, 7)
    assert.equal(built.column, 'email')
  })

  it('gives every descriptor a fresh id, so staging the same thing twice is two chips', () => {
    const a = rowsAttachment(VIEW, RESULT, [1], 'x')
    const b = rowsAttachment(VIEW, RESULT, [1], 'x')
    assert.notEqual(a.id, b.id)
  })

  it('labels every offer with real text, never a raw catalog key', () => {
    const out = contextActionsFor(
      { view: queryView, resultId: RESULT, selectedRows: [1], cell: { rowIndex: 1, column: 'c' } },
      t,
    )
    for (const item of out) {
      assert.ok(item.label.length > 0)
      assert.ok(!item.label.startsWith('context.'), `untranslated key leaked: ${item.label}`)
    }
  })
})

describe('collectionRefOf', () => {
  it('maps a vector view onto its collection', () => {
    assert.deepEqual(collectionRefOf(vectorView), { kind: 'vectorCollection', collection: 'docs' })
  })
  it('returns null for the views that browse no collection', () => {
    assert.equal(collectionRefOf(queryView), null)
    assert.equal(collectionRefOf(treeView), null)
  })
})

/* ==================================================================
 * The disclosure gate.
 * ================================================================== */

describe('context consent', () => {
  it('starts ungranted, so the first attachment is always disclosed', () => {
    revokeContextConsent()
    assert.equal(hasContextConsent(), false)
  })

  it('remembers a grant for the session even with no storage available', () => {
    revokeContextConsent()
    grantContextConsent()
    assert.equal(hasContextConsent(), true)
  })

  it('can be revoked again', () => {
    grantContextConsent()
    revokeContextConsent()
    assert.equal(hasContextConsent(), false)
  })

  it('does not honour an acknowledgement of an older wording', () => {
    // A stored yes to a sentence the user never saw is not a yes.
    revokeContextConsent()
    const stale = JSON.stringify({ version: CONSENT_VERSION - 1, acceptedAt: Date.now() })
    const store = new Map<string, string>([['peek.chat.contextConsent', stale]])
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    resetContextConsentCache()
    assert.equal(hasContextConsent(), false)
    delete (globalThis as { localStorage?: unknown }).localStorage
    resetContextConsentCache()
  })
})

/* ==================================================================
 * Chip detail lines — the user-facing half of "never truncate silently".
 * ================================================================== */

describe('detailFor', () => {
  it('says nothing while an attachment is only staged', () => {
    // There is no honest thing to say about how much will be sent until it has
    // been resolved, and guessing is the silent-truncation bug in reverse.
    assert.equal(detailFor(undefined, t), null)
    assert.equal(detailFor({ notice: null }, t), null)
  })

  it('reports a row cut with both counts', () => {
    const s: AttachmentStatus = {
      notice: { unit: 'rows', included: 100, total: 12_345, reason: 'rowCap' },
    }
    const text = detailFor(s, t) ?? ''
    assert.ok(text.includes('100'))
    assert.ok(text.includes('12345') || text.includes('12,345'))
  })

  it('avoids printing null when the total is unknown', () => {
    const s: AttachmentStatus = {
      notice: { unit: 'rows', included: 100, total: null, reason: 'tokenBudget' },
    }
    const text = detailFor(s, t) ?? ''
    assert.ok(!text.includes('null'))
    assert.ok(text.includes('100'))
  })

  it('distinguishes "peek trimmed it" from "the result itself is incomplete"', () => {
    const trimmed = detailFor({ notice: { unit: 'rows', included: 5, total: 9, reason: 'rowCap' } }, t)
    const incomplete = detailFor(
      { notice: { unit: 'rows', included: 5, total: 9, reason: 'sourceTruncated' } },
      t,
    )
    assert.notEqual(trimmed, incomplete)
  })

  it('reports an attachment dropped for prompt budget, rather than showing nothing', () => {
    const text = detailFor({ notice: { unit: 'rows', included: 0, total: null, reason: 'promptBudget' } }, t)
    assert.ok(text !== null && text.length > 0)
  })

  it('reports a failure ahead of any notice', () => {
    const text = detailFor({ failed: true, notice: { unit: 'rows', included: 1, total: 2, reason: 'rowCap' } }, t)
    assert.equal(text, translate('en', 'context.chips.failed'))
  })
})
