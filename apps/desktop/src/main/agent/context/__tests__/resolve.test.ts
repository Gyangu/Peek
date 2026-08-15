import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  asAttachmentId,
  asChatId,
  asConnId,
  asResultId,
  asViewId,
  createEmptyWorkspace,
  peekError,
  snapshotWorkspace,
  truncatedValue,
  type ChatAttachment,
  type CollectionSchemaInfo,
  type ColumnDef,
  type PeekedValue,
  type ViewState,
  type Workspace,
} from '@peek/core'
import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '../budget'
import { buildPromptBlocks, toContentBlock } from '../blocks'
import { defaultAttachmentLabel, resolveAttachment, resolveAttachments, summarizeIndexes } from '../resolve'
import { createAttachmentStore } from '../store'
import type { ContextSource, TabularSlice } from '../types'
import { redactRulesFor } from '../../../../drivers/manifests'

/* ==================================================================
 * Resolution is where a descriptor meets reality — and reality is
 * allowed to have moved on. The invariant under test throughout:
 * a failure produces a payload that SAYS it failed. An attachment
 * that quietly carries nothing is indistinguishable, to a model,
 * from one asserting there is nothing.
 * ================================================================== */

const RESULT = asResultId('res_1')
const VIEW = asViewId('view_1')
const CONN = asConnId('conn_1')

const COLUMNS: ColumnDef[] = [
  { name: 'id', logical: 'number', nativeType: 'int4', primaryKey: true },
  { name: 'city', logical: 'string', nativeType: 'text' },
  { name: 'note', logical: 'string', nativeType: 'text', nullable: true },
]

function slice(rows: unknown[][], over: Partial<TabularSlice> = {}): TabularSlice {
  return { columns: COLUMNS, rows, totalRows: rows.length, truncated: false, ...over }
}

interface StubOptions {
  rows?: (offset: number, limit: number) => TabularSlice
  rowsError?: unknown
  describe?: CollectionSchemaInfo
  describeError?: unknown
  peeked?: PeekedValue
  peekError?: unknown
  views?: Record<string, ViewState>
  workspace?: Workspace
}

function stubSource(o: StubOptions = {}): ContextSource {
  const ws = o.workspace ?? createEmptyWorkspace()
  return {
    readResultRows(req) {
      if (o.rowsError !== undefined) return Promise.reject(o.rowsError)
      const fn = o.rows ?? ((): TabularSlice => slice([]))
      return Promise.resolve(fn(req.offset ?? 0, req.limit))
    },
    describeCollection() {
      if (o.describeError !== undefined) return Promise.reject(o.describeError)
      if (!o.describe) return Promise.reject(peekError('NOT_FOUND', 'no schema'))
      return Promise.resolve(o.describe)
    },
    peekValue() {
      if (o.peekError !== undefined) return Promise.reject(o.peekError)
      if (!o.peeked) return Promise.reject(peekError('UNSUPPORTED_CAPABILITY', 'no valuePeek'))
      return Promise.resolve(o.peeked)
    },
    readView(viewId) {
      return o.views?.[viewId] ?? null
    },
    getSnapshot() {
      return snapshotWorkspace(ws, redactRulesFor)
    },
  }
}

const rowsAttachment = (rowIndexes: number[]): ChatAttachment => ({
  id: asAttachmentId('att_1'),
  label: 'rows',
  kind: 'rows',
  viewId: VIEW,
  resultId: RESULT,
  rowIndexes,
})

/* ------------------------------------------------------------------ */

describe('resolveAttachment · rows', () => {
  it('serializes exactly the selected rows, not the span between them', async () => {
    const source = stubSource({
      rows: (offset, limit) =>
        slice(Array.from({ length: limit }, (_v, i) => [offset + i, `city${offset + i}`, null])),
    })
    const out = await resolveAttachment(rowsAttachment([2, 5]), { source })
    assert.equal(out.error, undefined)
    const body = out.text
    assert.ok(body.includes('2,"city2"'))
    assert.ok(body.includes('5,"city5"'))
    assert.ok(!body.includes('3,"city3"'), 'unselected rows must not leak in')
  })

  it('records the real row indexes so the model knows which rows these are', async () => {
    const source = stubSource({
      rows: (offset, limit) => slice(Array.from({ length: limit }, (_v, i) => [offset + i, 'x', null])),
    })
    const out = await resolveAttachment(rowsAttachment([2, 3, 4, 9]), { source })
    assert.ok(out.text.includes('2-4, 9'), 'a hand-picked set must not be described as "the first N"')
  })

  it('de-duplicates and sorts the selection', async () => {
    const source = stubSource({
      rows: (offset, limit) => slice(Array.from({ length: limit }, (_v, i) => [offset + i, 'x', null])),
    })
    const out = await resolveAttachment(rowsAttachment([5, 2, 5, 2]), { source })
    assert.ok(out.uri.includes('i=2,5'))
  })

  it('refuses a selection spanning more rows than it will read, and says why', async () => {
    const source = stubSource()
    const out = await resolveAttachment(rowsAttachment([1, 900_000]), { source })
    assert.equal(out.error?.code, 'BAD_REQUEST')
    assert.ok(/select rows that are closer together|attach the whole result/i.test(out.error?.message ?? ''))
    // The failure must still be visible to the model.
    assert.ok(out.text.includes('BAD_REQUEST'))
  })

  it('reports an empty selection instead of sending an empty table', async () => {
    const out = await resolveAttachment(rowsAttachment([]), { source: stubSource() })
    assert.equal(out.error?.code, 'BAD_REQUEST')
  })

  it('turns an evicted result into a NOT_FOUND that names the recovery', async () => {
    const source = stubSource({ rows: () => slice([]) })
    const out = await resolveAttachment(rowsAttachment([1, 2]), { source })
    assert.equal(out.error?.code, 'NOT_FOUND')
    assert.ok(/re-run/i.test(out.error?.message ?? ''))
  })

  it('never rejects — a thrown source becomes a payload carrying the error', async () => {
    const source = stubSource({ rowsError: new Error('port closed') })
    const out = await resolveAttachment(rowsAttachment([0]), { source })
    assert.ok(out.error, 'the error must survive into the payload')
    assert.ok(out.text.includes('port closed'))
  })
})

describe('resolveAttachment · result', () => {
  const attachment: ChatAttachment = {
    id: asAttachmentId('att_r'),
    label: 'result',
    kind: 'result',
    viewId: VIEW,
    resultId: RESULT,
    maxRows: 500,
  }

  it('states the true total when it sends only part of a result', async () => {
    const source = stubSource({
      rows: (_o, limit) =>
        slice(Array.from({ length: Math.min(limit, 50) }, (_v, i) => [i, 'x', null]), {
          totalRows: 12_345,
          truncated: true,
        }),
    })
    const out = await resolveAttachment(attachment, { source })
    assert.ok(out.text.includes('12,345'), 'the model must see the real size')
    assert.equal(out.notice?.reason, 'sourceTruncated')
    assert.equal(out.notice?.total, 12_345)
  })

  it('honours the smaller of the descriptor cap and the budget cap', async () => {
    let asked = 0
    const source = stubSource({
      rows: (_o, limit) => {
        asked = limit
        return slice([])
      },
    })
    const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, maxRows: 10 }
    await resolveAttachment(attachment, { source, budget })
    assert.equal(asked, 10)
  })
})

describe('resolveAttachment · cells', () => {
  const cells = (over: Partial<Extract<ChatAttachment, { kind: 'cells' }>> = {}): ChatAttachment => ({
    id: asAttachmentId('att_x'),
    label: 'block',
    kind: 'cells',
    viewId: VIEW,
    resultId: RESULT,
    r0: 1,
    r1: 3,
    columns: ['id', 'note'],
    ...over,
  })

  it('reads the closed interval and keeps only the selected columns', async () => {
    let asked: { offset: number; limit: number } | null = null
    const source = stubSource({
      rows: (offset, limit) => {
        asked = { offset, limit }
        return slice([[1, 'lisbon', 'a'], [2, 'porto', 'b'], [3, 'faro', 'c']])
      },
    })
    const out = await resolveAttachment(cells(), { source })
    assert.deepEqual(asked, { offset: 1, limit: 3 }, 'r0..r1 inclusive is three rows from offset 1')
    assert.equal(out.error, undefined)
    assert.ok(out.text.includes('note'))
    assert.ok(!out.text.includes('city'), 'a column outside the rectangle must not be sent')
    assert.ok(!out.text.includes('lisbon'))
  })

  it('fails loudly when the projection changed under it', async () => {
    // The case column *names* exist to catch: indexes would have pointed at
    // whatever now sits in that position, and said nothing.
    const source = stubSource({ rows: () => slice([[1, 'x', 'y']]) })
    const out = await resolveAttachment(cells({ columns: ['gone', 'missing'] }), { source })
    assert.ok(out.error)
    assert.match(out.text, /projection/i)
  })

  it('sends what it can and names what it could not, on a partial match', async () => {
    const source = stubSource({ rows: () => slice([[1, 'x', 'y']]) })
    const out = await resolveAttachment(cells({ columns: ['id', 'vanished'] }), { source })
    assert.equal(out.error, undefined)
    assert.match(out.text, /vanished/)
  })

  it('refuses a span wider than it will read, rather than reading it', async () => {
    const out = await resolveAttachment(cells({ r0: 0, r1: 900_000 }), { source: stubSource() })
    assert.ok(out.error)
    assert.match(out.text, /900,001|Select fewer rows/)
  })
})

describe('resolveAttachment · cell', () => {
  const attachment: ChatAttachment = {
    id: asAttachmentId('att_c'),
    label: 'cell',
    kind: 'cell',
    viewId: VIEW,
    resultId: RESULT,
    rowIndex: 3,
    column: 'note',
  }

  it('emits the whole value, not the grid preview, when valuePeek can supply it', async () => {
    const ref = { kind: 'resultCell', resultId: RESULT, row: 3, col: 2 } as const
    const source = stubSource({
      rows: () => slice([[3, 'x', truncatedValue('BEGIN', 'utf8', { byteLength: 900, ref })]]),
      peeked: { ref, encoding: 'utf8', data: 'THE WHOLE VALUE', byteLength: 15, eof: true },
      views: { [VIEW]: { id: VIEW, kind: 'query', status: 'ready', connId: CONN, text: 'select 1' } },
    })
    const out = await resolveAttachment(attachment, { source })
    assert.ok(out.text.includes('THE WHOLE VALUE'))
    assert.ok(!out.text.includes('BEGIN'), 'the preview must be replaced, not appended')
  })

  it('falls back to the preview and labels it as one when the peek fails', async () => {
    const ref = { kind: 'resultCell', resultId: RESULT, row: 3, col: 2 } as const
    const source = stubSource({
      rows: () => slice([[3, 'x', truncatedValue('BEGIN', 'utf8', { byteLength: 900, ref })]]),
      peekError: new Error('driver gone'),
      views: { [VIEW]: { id: VIEW, kind: 'query', status: 'ready', connId: CONN, text: 'select 1' } },
    })
    const out = await resolveAttachment(attachment, { source })
    assert.ok(out.text.includes('BEGIN'))
    assert.ok(/only the preview/i.test(out.text), 'a preview presented as the value is the failure mode')
    assert.equal(out.error, undefined, 'a failed peek is not a failed attachment')
  })

  it('reports a column the result no longer has', async () => {
    const source = stubSource({ rows: () => slice([[3, 'x', 'y']], { columns: [COLUMNS[0]] }) })
    const out = await resolveAttachment(attachment, { source })
    assert.equal(out.error?.code, 'NOT_FOUND')
  })

  it('renders SQL NULL explicitly rather than as an empty block', async () => {
    const source = stubSource({ rows: () => slice([[3, 'x', null]]) })
    const out = await resolveAttachment(attachment, { source })
    assert.ok(out.text.includes('NULL'))
  })
})

describe('resolveAttachment · query', () => {
  it('reads the live text out of the view', async () => {
    const view: ViewState = { id: VIEW, kind: 'query', status: 'ready', connId: CONN, text: 'SELECT 42' }
    const out = await resolveAttachment(
      { id: asAttachmentId('att_q'), label: 'q', kind: 'query', viewId: VIEW },
      { source: stubSource({ views: { [VIEW]: view } }) },
    )
    assert.ok(out.text.includes('SELECT 42'))
    assert.ok(out.text.includes('```sql'))
  })

  it('reports a closed view instead of sending an empty query', async () => {
    const out = await resolveAttachment(
      { id: asAttachmentId('att_q'), label: 'q', kind: 'query', viewId: VIEW },
      { source: stubSource() },
    )
    assert.equal(out.error?.code, 'NOT_FOUND')
  })

  it('rejects a view that is not a query editor', async () => {
    const view: ViewState = {
      id: VIEW,
      kind: 'table',
      status: 'ready',
      connId: CONN,
      ref: { kind: 'relation', schema: 'public', name: 't' },
      page: { offset: 0, limit: 100 },
    }
    const out = await resolveAttachment(
      { id: asAttachmentId('att_q'), label: 'q', kind: 'query', viewId: VIEW },
      { source: stubSource({ views: { [VIEW]: view } }) },
    )
    assert.equal(out.error?.code, 'BAD_REQUEST')
  })
})

describe('resolveAttachment · workspace and credentials', () => {
  it('never emits a connection config, redacted or otherwise', async () => {
    const ws = createEmptyWorkspace()
    ws.connections[CONN] = {
      id: CONN,
      driverId: 'postgres',
      identity: 'postgres\u0000postgresql://admin@db.internal:5432/app',
      label: 'prod',
      detail: 'postgresql://admin:***@db.internal:5432/app',
      endpoint: 'db.internal:5432/app',
      config: {
        driverId: 'postgres',
        url: 'postgresql://admin:hunter2@db.internal:5432/app',
        password: 'hunter2',
        user: 'admin',
        host: 'db.internal',
      },
      status: 'ready',
      capabilities: ['tabularQuery'],
    }
    const out = await resolveAttachment(
      { id: asAttachmentId('att_w'), label: 'ws', kind: 'workspace' },
      { source: stubSource({ workspace: ws }) },
    )
    // The whole point of the feature is that this can never appear.
    assert.ok(!out.text.includes('hunter2'), 'a password must never reach an attachment')
    assert.ok(!out.text.includes('db.internal'), 'the host is config, and config is dropped wholesale')
    assert.ok(!out.text.includes('admin'))
    assert.ok(!out.text.includes('***'), 'not even the redaction placeholder is worth sending')
    // What it must keep: enough to reason about the window.
    assert.ok(out.text.includes('prod'))
    assert.ok(out.text.includes('postgres'))
  })

  it('says outright that credentials are excluded', async () => {
    const out = await resolveAttachment(
      { id: asAttachmentId('att_w'), label: 'ws', kind: 'workspace' },
      { source: stubSource() },
    )
    assert.ok(/credentials are never included/i.test(out.text))
  })
})

describe('resolveAttachment · schema', () => {
  it('renders the structure through the schema renderer', async () => {
    const out = await resolveAttachment(
      {
        id: asAttachmentId('att_s'),
        label: 's',
        kind: 'schema',
        connId: CONN,
        ref: { kind: 'relation', schema: 'public', name: 'orders' },
      },
      {
        source: stubSource({
          describe: {
            ref: { kind: 'relation', schema: 'public', name: 'orders' },
            columns: COLUMNS,
            primaryKey: ['id'],
          },
        }),
      },
    )
    assert.ok(out.text.includes('public.orders'))
    assert.ok(out.text.includes('Primary key: id'))
  })

  it('turns a driver failure into a stated error', async () => {
    const out = await resolveAttachment(
      {
        id: asAttachmentId('att_s'),
        label: 's',
        kind: 'schema',
        connId: CONN,
        ref: { kind: 'relation', schema: 'public', name: 'orders' },
      },
      { source: stubSource({ describeError: peekError('CONNECTION_LOST', 'socket closed') }) },
    )
    assert.equal(out.error?.code, 'CONNECTION_LOST')
  })
})

describe('resolveAttachments · prompt-wide budget', () => {
  it('spends the budget in order and never drops an attachment silently', async () => {
    const source = stubSource({
      rows: (_o, limit) =>
        slice(Array.from({ length: limit }, (_v, i) => [i, 'x'.repeat(200), 'y'.repeat(200)])),
    })
    const budget: ContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxTokensPerPrompt: 500,
      maxTokensPerAttachment: 400,
      maxRows: 200,
    }
    const list: ChatAttachment[] = [
      { id: asAttachmentId('a1'), label: 'r1', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 200 },
      { id: asAttachmentId('a2'), label: 'r2', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 200 },
      { id: asAttachmentId('a3'), label: 'r3', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 200 },
    ]
    const out = await resolveAttachments(list, { source, budget })
    assert.equal(out.length, 3, 'every staged attachment must come back')
    const omitted = out.filter((r) => r.notice?.reason === 'promptBudget')
    assert.ok(omitted.length >= 1, 'the budget must actually bind')
    for (const o of omitted) assert.ok(/omitted/i.test(o.text), 'an omitted attachment must say so')
  })

  it('keeps every attachment when the budget is ample', async () => {
    const source = stubSource({ rows: () => slice([[1, 'a', null]]) })
    const list: ChatAttachment[] = [
      { id: asAttachmentId('a1'), label: 'r1', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 10 },
      { id: asAttachmentId('a2'), label: 'r2', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 10 },
    ]
    const out = await resolveAttachments(list, { source })
    assert.equal(out.filter((r) => r.notice?.reason === 'promptBudget').length, 0)
  })
})

describe('summarizeIndexes', () => {
  it('collapses runs and keeps singletons', () => {
    assert.equal(summarizeIndexes([1, 2, 3, 7, 10, 11]), '1-3, 7, 10-11')
  })
  it('handles a single index and an empty list', () => {
    assert.equal(summarizeIndexes([4]), '4')
    assert.equal(summarizeIndexes([]), '')
  })
})

describe('defaultAttachmentLabel', () => {
  it('names every attachment kind', () => {
    const kinds: ChatAttachment[] = [
      rowsAttachment([1, 2]),
      { id: asAttachmentId('x'), label: '', kind: 'result', viewId: VIEW, resultId: RESULT, maxRows: 1 },
      { id: asAttachmentId('x'), label: '', kind: 'cell', viewId: VIEW, resultId: RESULT, rowIndex: 1, column: 'c' },
      { id: asAttachmentId('x'), label: '', kind: 'cells', viewId: VIEW, resultId: RESULT, r0: 0, r1: 2, columns: ['c'] },
      { id: asAttachmentId('x'), label: '', kind: 'schema', connId: CONN, ref: { kind: 'relation', schema: 's', name: 't' } },
      { id: asAttachmentId('x'), label: '', kind: 'query', viewId: VIEW },
      { id: asAttachmentId('x'), label: '', kind: 'workspace' },
    ]
    for (const k of kinds) assert.ok(defaultAttachmentLabel(k).length > 0)
  })
})

/* ------------------------------------------------------------------ */
/* Blocks + store                                                      */
/* ------------------------------------------------------------------ */

const resolved = (over: Partial<import('../resolve').ResolvedAttachment> = {}) => ({
  attachmentId: asAttachmentId('att_1'),
  uri: 'peek://result/res_1/rows',
  mimeType: 'text/markdown' as const,
  text: 'body',
  notice: null,
  estimatedTokens: 10,
  ...over,
})

describe('toContentBlock', () => {
  it('embeds a resource when the agent advertises embeddedContext', () => {
    const { block } = toContentBlock(resolved(), { embeddedContext: true })
    assert.equal(block.type, 'resource')
    if (block.type !== 'resource') return
    assert.equal(block.resource.uri, 'peek://result/res_1/rows')
    assert.equal(block.resource.mimeType, 'text/markdown')
  })

  it('degrades to a text block rather than dropping the content', () => {
    const { block } = toContentBlock(resolved(), { embeddedContext: false })
    assert.equal(block.type, 'text')
    if (block.type !== 'text') return
    assert.ok(block.text.includes('body'))
    assert.ok(block.text.includes('peek://result/res_1/rows'), 'the URI must survive the degradation')
  })

  it('inlines a large attachment in full when no fetch tool exists', () => {
    const big = resolved({ text: 'x'.repeat(60_000), estimatedTokens: 20_000 })
    const { block } = toContentBlock(big, { embeddedContext: true })
    if (block.type !== 'resource') throw new Error('expected resource')
    assert.equal(block.resource.text.length, 60_000, 'pointing at a tool that is not registered would be worse')
  })

  it('sends a head plus a fetch instruction when a fetch tool exists', () => {
    const big = resolved({ text: 'line\n'.repeat(12_000), estimatedTokens: 20_000 })
    const { block, store } = toContentBlock(big, {
      embeddedContext: true,
      fetchToolName: 'mcp__peek__read_attachment',
    })
    if (block.type !== 'resource') throw new Error('expected resource')
    assert.ok(block.resource.text.length < big.text.length, 'must actually shorten')
    assert.ok(block.resource.text.includes('mcp__peek__read_attachment'))
    assert.ok(/offset=\d+/.test(block.resource.text), 'the model must be told where to resume')
    assert.equal(store?.text.length, big.text.length, 'the store always holds the full document')
  })

  it('never truncates a failed attachment into a fetch instruction', () => {
    const bad = resolved({
      text: 'x'.repeat(60_000),
      estimatedTokens: 20_000,
      error: peekError('NOT_FOUND', 'gone'),
    })
    const { block } = toContentBlock(bad, { embeddedContext: true, fetchToolName: 'mcp__peek__read_attachment' })
    if (block.type !== 'resource') throw new Error('expected resource')
    assert.ok(!block.resource.text.includes('read_attachment'))
  })
})

describe('buildPromptBlocks', () => {
  it('puts the user text first and the attachments after it', () => {
    const { blocks } = buildPromptBlocks('what is this?', [resolved()], { embeddedContext: true })
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]?.type, 'text')
    assert.equal(blocks[1]?.type, 'resource')
  })

  it('omits an empty user message rather than sending a blank block', () => {
    const { blocks } = buildPromptBlocks('', [resolved()], { embeddedContext: true })
    assert.equal(blocks.length, 1)
  })
})

describe('attachmentStore', () => {
  it('round-trips a document', () => {
    const store = createAttachmentStore()
    store.put({ uri: 'peek://a', mimeType: 'text/markdown', text: 'hello world' })
    const page = store.read({ uri: 'peek://a' })
    assert.ok(!('code' in page))
    if ('code' in page) return
    assert.equal(page.text, 'hello world')
    assert.equal(page.hasMore, false)
    assert.equal(page.totalChars, 11)
  })

  it('pages with an explicit offset and reports whether more remains', () => {
    const store = createAttachmentStore()
    store.put({ uri: 'peek://a', mimeType: 'text/markdown', text: 'abcdefghij' })
    const first = store.read({ uri: 'peek://a', offset: 0, limit: 4 })
    if ('code' in first) throw new Error('unexpected error')
    assert.equal(first.text, 'abcd')
    assert.equal(first.hasMore, true)
    const last = store.read({ uri: 'peek://a', offset: 8, limit: 4 })
    if ('code' in last) throw new Error('unexpected error')
    assert.equal(last.text, 'ij')
    assert.equal(last.hasMore, false)
  })

  it('tells the model to ask the user again when the URI is gone', () => {
    const store = createAttachmentStore()
    const out = store.read({ uri: 'peek://missing' })
    assert.ok('code' in out)
    if (!('code' in out)) return
    assert.equal(out.code, 'NOT_FOUND')
    assert.ok(/attach it again/i.test(out.message))
  })

  it('evicts oldest-first past the entry cap', () => {
    const store = createAttachmentStore({ maxEntries: 2 })
    store.put({ uri: 'a', mimeType: 'text/markdown', text: '1' })
    store.put({ uri: 'b', mimeType: 'text/markdown', text: '2' })
    store.put({ uri: 'c', mimeType: 'text/markdown', text: '3' })
    assert.ok('code' in store.read({ uri: 'a' }))
    assert.ok(!('code' in store.read({ uri: 'c' })))
  })

  it('replaces rather than duplicates when the same URI is staged twice', () => {
    const store = createAttachmentStore()
    store.put({ uri: 'a', mimeType: 'text/markdown', text: 'old' })
    store.put({ uri: 'a', mimeType: 'text/markdown', text: 'new' })
    const page = store.read({ uri: 'a' })
    if ('code' in page) throw new Error('unexpected error')
    assert.equal(page.text, 'new')
    assert.equal(store.list().length, 1)
  })

  it('evicts by total size, not just by count', () => {
    const store = createAttachmentStore({ maxEntries: 100, maxChars: 10 })
    store.put({ uri: 'a', mimeType: 'text/markdown', text: 'x'.repeat(8) })
    store.put({ uri: 'b', mimeType: 'text/markdown', text: 'y'.repeat(8) })
    assert.ok('code' in store.read({ uri: 'a' }), 'the byte ceiling must bind independently')
  })
})
