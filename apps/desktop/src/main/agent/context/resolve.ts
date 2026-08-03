/**
 * Descriptor → payload. The moment an attachment stops being a promise about
 * data and becomes the data.
 *
 * ## Resolution happens at send time, and that is the point
 *
 * `ChatAttachment` is a descriptor (`chat.ts` argues why at length). The user
 * pins "the result of this query", edits the SQL, re-runs it, then sends — and
 * what reaches the model is the *new* result, because nothing was captured until
 * this function ran. The corollary is that resolution can fail: the result may
 * have been evicted from the renderer's LRU, the view may be closed, the
 * connection may have dropped. Every failure below becomes a payload carrying a
 * `PeekError`, never a payload that is quietly empty — an attachment that says
 * nothing looks exactly like an attachment saying "there is nothing", and the two
 * lead a model to opposite conclusions.
 *
 * ## The credential rule
 *
 * **No connection config ever enters a payload.** This is enforced by type, not
 * by care: `ContextSource.getSnapshot` returns `WorkspaceSnapshot`, which
 * `snapshotWorkspace` has already run `redactConnectionConfig` over, so the raw
 * `Workspace` (the only object holding plaintext passwords) is not reachable from
 * this module at all. On top of that, `resolveWorkspace` drops the `config`
 * object outright rather than forwarding the redacted one: a model needs to know
 * *which* database a view is looking at, and the label, driver and status say
 * that. A host, port, username and `***` add nothing it can act on, and shipping
 * a DSN-shaped string to a third party is a habit worth not having.
 */

import {
  collectionRefLabel,
  peekError,
  toPeekError,
  type AttachmentId,
  type ChatAttachment,
  type ChatAttachmentReceipt,
  type AttachmentPayload,
  type PeekError,
  type WorkspaceSnapshot,
} from '@peek/core'
import {
  DEFAULT_CONTEXT_BUDGET,
  clampValue,
  estimateTokens,
  planRowFit,
  type ContextBudget,
  type TruncationNotice,
} from './budget'
import {
  CSV_CONVENTION,
  TRUNCATION_MARK,
  columnLegend,
  csvField,
  renderCsv,
  renderDocument,
  renderSchema,
} from './serialize'
import type { ContextSource, TabularSlice } from './types'
import { queryUri, resultCellUri, resultRowsUri, schemaUri, workspaceUri } from './uri'

/**
 * A resolved attachment.
 *
 * Extends the core `AttachmentPayload` rather than replacing it, adding what the
 * *UI* needs and the agent does not: what was cut (so a chip can say "first 100
 * of 12,345" in the user's language) and what it cost (so a context meter can
 * show the price before the message is sent).
 */
export interface ResolvedAttachment extends AttachmentPayload {
  /** Non-null when something was left out. Localized by the renderer. */
  notice: TruncationNotice | null
  /** Conservative token estimate for `text`; see `estimateTokens`. */
  estimatedTokens: number
}

export interface ResolveOptions {
  source: ContextSource
  budget?: ContextBudget
  timeoutMs?: number
}

/** The part of a resolved attachment a receipt is made from. */
export interface AttachmentOutcome {
  attachmentId: AttachmentId
  notice?: TruncationNotice | null
  error?: PeekError
}

/**
 * What the transcript records about attachments that did **not** arrive whole.
 *
 * Only the shortfalls: an attachment that delivered everything it promised needs
 * no receipt, and one per attachment would put a row on screen saying nothing.
 * What this exists for is the opposite case — the transcript can say "first 100
 * of 12,345 rows" instead of leaving the user to assume the model saw all of it.
 *
 * Lives here rather than in either backend because both need it and the rule is
 * about attachments, not about agents.
 *
 * The parameter is the three fields this reads and nothing else, so the two
 * backends' slightly different payload types both satisfy it without either
 * being widened to match the other.
 */
export function buildAttachmentReceipts(
  resolved: readonly AttachmentOutcome[],
): ChatAttachmentReceipt[] {
  const out: ChatAttachmentReceipt[] = []
  for (const a of resolved) {
    const failed = a.error !== undefined
    if (!failed && (a.notice === undefined || a.notice === null)) continue
    out.push({
      attachmentId: a.attachmentId,
      ...(a.notice ? { notice: a.notice } : {}),
      ...(failed ? { failed: true } : {}),
    })
  }
  return out
}

/**
 * Widest span of rows this module will pull to satisfy a sparse selection.
 *
 * `ContextSource.readResultRows` addresses rows by offset and limit, but a user
 * can ctrl-click row 12 and row 480,000. Reading the span between them to pick
 * two rows out of it would haul half a result set through IPC to serialize
 * ~200 bytes. Past this width the attachment fails loudly and names the problem,
 * which is recoverable (the user narrows the selection); silently dropping the
 * far rows is not, because the model would be told it had them.
 *
 * Mirrored in the renderer as `MAX_SELECTION_SPAN`, which warns the user before
 * they send. That copy is advisory; **this one is the guarantee**.
 */
const MAX_ROW_SPAN = 20_000

/* ================================================================== */
/* Entry points                                                        */
/* ================================================================== */

/**
 * Resolve one attachment. Never rejects — a failure becomes a payload whose
 * `error` is set and whose `text` explains, in English, what the model is not
 * getting and why.
 */
export async function resolveAttachment(
  attachment: ChatAttachment,
  options: ResolveOptions,
): Promise<ResolvedAttachment> {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET
  try {
    return await resolveInner(attachment, options, budget)
  } catch (e) {
    return failed(attachment, toPeekError(e))
  }
}

/**
 * Resolve every attachment staged on one message, under a shared prompt-wide
 * budget.
 *
 * Sequential, and deliberately so: the budget is spent in order, so an earlier
 * attachment's real cost constrains a later one. Resolving in parallel and
 * trimming afterwards would mean fetching data only to throw it away, and would
 * make which attachment survives depend on which IPC round-trip returned first —
 * i.e. non-deterministic, for no gain on a handful of items.
 *
 * An attachment that finds the budget already spent is **not dropped**. It comes
 * back as a payload with a `promptBudget` notice and no body, so both the user
 * and the model can see that it was staged and did not fit. Vanishing silently is
 * the one outcome this module never allows.
 */
export async function resolveAttachments(
  attachments: readonly ChatAttachment[],
  options: ResolveOptions,
): Promise<ResolvedAttachment[]> {
  const budget = options.budget ?? DEFAULT_CONTEXT_BUDGET
  const out: ResolvedAttachment[] = []
  let spent = 0
  for (const a of attachments) {
    const remaining = budget.maxTokensPerPrompt - spent
    if (remaining <= 0) {
      out.push(overBudget(a))
      continue
    }
    // Never let one attachment exceed what is left of the prompt-wide budget.
    const scoped: ContextBudget = {
      ...budget,
      maxTokensPerAttachment: Math.min(budget.maxTokensPerAttachment, remaining),
    }
    const resolved = await resolveAttachment(a, { ...options, budget: scoped })
    spent += resolved.estimatedTokens
    out.push(resolved)
  }
  return out
}

/* ================================================================== */
/* Per-kind resolution                                                 */
/* ================================================================== */

async function resolveInner(
  attachment: ChatAttachment,
  options: ResolveOptions,
  budget: ContextBudget,
): Promise<ResolvedAttachment> {
  switch (attachment.kind) {
    case 'rows':
      return resolveRows(attachment, options, budget)
    case 'result':
      return resolveResult(attachment, options, budget)
    case 'cell':
      return resolveCell(attachment, options, budget)
    case 'schema':
      return resolveSchema(attachment, options)
    case 'query':
      return resolveQuery(attachment, options, budget)
    case 'workspace':
      return resolveWorkspace(attachment, options)
  }
}

/* --- rows: the ones the user selected ----------------------------- */

async function resolveRows(
  a: Extract<ChatAttachment, { kind: 'rows' }>,
  options: ResolveOptions,
  budget: ContextBudget,
): Promise<ResolvedAttachment> {
  const indexes = [...new Set(a.rowIndexes)].sort((x, y) => x - y)
  if (indexes.length === 0) {
    return failed(a, peekError('BAD_REQUEST', 'No rows were selected for this attachment.'))
  }
  const first = indexes[0] ?? 0
  const last = indexes[indexes.length - 1] ?? 0
  const span = last - first + 1
  if (span > MAX_ROW_SPAN) {
    return failed(
      a,
      peekError(
        'BAD_REQUEST',
        `The selected rows span ${span.toLocaleString('en-US')} positions (row ${first} to row ${last}), `
        + `which is more than peek will read to serialize ${indexes.length} rows. `
        + 'Select rows that are closer together, or attach the whole result instead.',
      ),
    )
  }

  const slice = await options.source.readResultRows({
    resultId: a.resultId,
    offset: first,
    limit: span,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

  // Pick out exactly the requested rows. A row the source could not supply
  // (evicted, or past what actually arrived) is dropped from the body and
  // counted, so the notice can say how many of the selection made it.
  const picked: unknown[][] = []
  for (const i of indexes) {
    const row = slice.rows[i - first]
    if (row !== undefined) picked.push(row)
  }
  if (picked.length === 0) {
    return failed(
      a,
      peekError(
        'NOT_FOUND',
        'None of the selected rows are still loaded. The result set may have been evicted '
        + "from peek's cache — re-run the query and select them again.",
      ),
    )
  }

  const body: TabularSlice = {
    columns: slice.columns,
    rows: picked,
    totalRows: indexes.length,
    truncated: picked.length < indexes.length,
  }
  const doc = renderTabular({
    title: `Selected rows · ${indexes.length} row(s)`,
    facts: [`Source: result \`${a.resultId}\` · view \`${a.viewId}\``],
    slice: body,
    budget,
    // The rows are a hand-picked set, so "1-100 of 12,345" would be a lie about
    // which rows these are. Their real indexes are what identifies them.
    rowLabel: `rows at indexes ${summarizeIndexes(indexes)}`,
  })
  return ok(a, resultRowsUri(a.resultId, indexes), doc.text, doc.notice)
}

/* --- result: the whole (capped) result set ------------------------ */

async function resolveResult(
  a: Extract<ChatAttachment, { kind: 'result' }>,
  options: ResolveOptions,
  budget: ContextBudget,
): Promise<ResolvedAttachment> {
  const limit = Math.min(a.maxRows, budget.maxRows)
  const slice = await options.source.readResultRows({
    resultId: a.resultId,
    offset: 0,
    limit,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const doc = renderTabular({
    title: `Result set · ${slice.totalRows.toLocaleString('en-US')} row(s)`,
    facts: [`Source: result \`${a.resultId}\` · view \`${a.viewId}\``],
    slice,
    budget,
    rowLabel: 'the first rows of the result',
  })
  return ok(a, resultRowsUri(a.resultId), doc.text, doc.notice)
}

/* --- cell: one value, in full ------------------------------------- */

async function resolveCell(
  a: Extract<ChatAttachment, { kind: 'cell' }>,
  options: ResolveOptions,
  budget: ContextBudget,
): Promise<ResolvedAttachment> {
  const slice = await options.source.readResultRows({
    resultId: a.resultId,
    offset: a.rowIndex,
    limit: 1,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  const colIndex = slice.columns.findIndex((c) => c.name === a.column)
  if (colIndex < 0) {
    return failed(
      a,
      peekError('NOT_FOUND', `Column "${a.column}" is not in this result set. It may have been re-run with a different projection.`),
    )
  }
  const row = slice.rows[0]
  if (row === undefined) {
    return failed(
      a,
      peekError('NOT_FOUND', `Row ${a.rowIndex} is no longer loaded. Re-run the query and select the cell again.`),
    )
  }

  const column = slice.columns[colIndex]
  const raw = row[colIndex]
  const full = await fullValueText(raw, a, options)
  const { text: clamped, notice } = clampValue(full.text, budget)
  const body = notice === null ? clamped : `${clamped}${TRUNCATION_MARK}`

  const facts = [
    `Source: result \`${a.resultId}\` · row ${a.rowIndex} · column \`${a.column}\``,
    column === undefined ? '' : `Type: \`${column.nativeType}\` (logical: ${column.logical})`,
    full.note,
  ].filter((s) => s.length > 0)

  const doc = renderDocument({
    title: `Cell value · ${a.column}`,
    facts,
    notices: [notice],
    fence: { lang: full.lang, text: body },
  })
  return ok(a, resultCellUri(a.resultId, a.rowIndex, a.column), doc, notice)
}

/**
 * Get the whole value behind a cell.
 *
 * A driver replaces anything past `VALUE_PREVIEW_BYTES` with a `TruncatedValue`
 * carrying a preview and a `ValueRef`. Attaching a cell is almost always *because*
 * the grid could only show that preview, so this follows the ref through
 * `valuePeek` to fetch the rest. When the driver has no such capability, or the
 * fetch fails, the preview is used and the document says so — a preview labelled
 * as a preview is useful; a preview presented as the value is not.
 */
async function fullValueText(
  raw: unknown,
  a: Extract<ChatAttachment, { kind: 'cell' }>,
  options: ResolveOptions,
): Promise<{ text: string; lang: string; note: string }> {
  const truncated = isTruncated(raw)
  if (truncated && truncated.ref && options.source.peekValue) {
    const connId = viewConnId(options.source, a.viewId)
    if (connId) {
      try {
        const peeked = await options.source.peekValue({
          connId,
          ref: truncated.ref,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
        const note = peeked.eof
          ? ''
          : `Note: this is the first ${peeked.byteLength.toLocaleString('en-US')} bytes`
            + `${peeked.totalBytes === undefined ? '' : ` of ${peeked.totalBytes.toLocaleString('en-US')}`}; the value continues.`
        return {
          text: peeked.encoding === 'base64' ? peeked.data : peeked.data,
          lang: langFor(peeked.contentType, peeked.encoding),
          note,
        }
      } catch {
        // Fall through to the preview: a failed peek is not a failed attachment.
      }
    }
  }
  if (truncated) {
    const size = truncated.byteLength === undefined ? '' : ` (full value is ${truncated.byteLength.toLocaleString('en-US')} bytes)`
    return {
      text: truncated.preview,
      lang: truncated.encoding === 'base64' ? 'text' : 'text',
      note: `Note: this is only the preview peek received${size}; the full value could not be fetched.`,
    }
  }
  return { text: plainValueText(raw), lang: langFor(undefined, 'utf8'), note: '' }
}

function langFor(contentType: string | undefined, encoding: string): string {
  if (encoding === 'base64') return 'text'
  if (contentType === 'application/json') return 'json'
  return 'text'
}

function plainValueText(raw: unknown): string {
  if (raw === null || raw === undefined) return '\\N  (SQL NULL)'
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) ?? String(raw)
    } catch {
      return String(raw)
    }
  }
  return String(raw)
}

function isTruncated(v: unknown): { preview: string; encoding: string; byteLength?: number; ref?: import('@peek/core').ValueRef } | null {
  if (typeof v !== 'object' || v === null) return null
  const rec = v as Record<string, unknown>
  if (rec['__peekTruncated'] !== true) return null
  return rec as unknown as { preview: string; encoding: string; byteLength?: number; ref?: import('@peek/core').ValueRef }
}

/* --- schema ------------------------------------------------------- */

async function resolveSchema(
  a: Extract<ChatAttachment, { kind: 'schema' }>,
  options: ResolveOptions,
): Promise<ResolvedAttachment> {
  const info = await options.source.describeCollection({
    connId: a.connId,
    ref: a.ref,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return ok(a, schemaUri(a.connId, a.ref), renderSchema(info), null)
}

/* --- query text --------------------------------------------------- */

function resolveQuery(
  a: Extract<ChatAttachment, { kind: 'query' }>,
  options: ResolveOptions,
  budget: ContextBudget,
): ResolvedAttachment {
  const view = options.source.readView(a.viewId)
  if (!view) {
    return failed(a, peekError('NOT_FOUND', `View ${a.viewId} is no longer open, so its query text cannot be read.`))
  }
  if (view.kind !== 'query') {
    return failed(a, peekError('BAD_REQUEST', `View ${a.viewId} is a ${view.kind} view, not a query editor.`))
  }
  const { text, notice } = clampValue(view.text, budget)
  return ok(
    a,
    queryUri(a.viewId),
    renderDocument({
      title: 'Query text',
      facts: [`Source: query view \`${a.viewId}\` · connection \`${view.connId}\``],
      notices: [notice],
      fence: { lang: 'sql', text },
    }),
    notice,
  )
}

/* --- workspace ---------------------------------------------------- */

function resolveWorkspace(
  a: Extract<ChatAttachment, { kind: 'workspace' }>,
  options: ResolveOptions,
): ResolvedAttachment {
  const snap = options.source.getSnapshot()
  return ok(a, workspaceUri(), renderWorkspace(snap), null)
}

/**
 * What the user is looking at.
 *
 * `config` is dropped rather than forwarded. `snapshotWorkspace` has already
 * redacted it, so passing it on would be *safe* — but a redacted DSN is still a
 * host, a port, a username and a database name, and none of that helps a model
 * reason about the window. Sending the least that answers the question is the
 * cheaper habit and the safer one.
 */
function renderWorkspace(snap: WorkspaceSnapshot): string {
  const connections = snap.connections
    .map((c) => `- \`${c.id}\` **${c.label}** · ${c.driverId} · ${c.status} · capabilities: ${c.capabilities.join(', ')}`)
    .join('\n')
  const views = snap.views
    .map(
      (v) =>
        `- \`${v.id}\` ${v.kind}${v.visible ? ' **(on screen)**' : ' (background tab)'}`
        + ` · panel ${v.panelId ?? 'none'} · ${v.describe}`,
    )
    .join('\n')

  return renderDocument({
    title: 'peek workspace',
    facts: [`Revision ${snap.rev} · ${snap.views.length} view(s) · ${snap.connections.length} connection(s)`],
    prose:
      `## Connections\n\n${connections || '_none_'}\n\n`
      + `## Views\n\n${views || '_none_'}\n\n`
      + '_Connection credentials are never included in peek attachments._',
  })
}

/* ================================================================== */
/* Shared rendering + result construction                              */
/* ================================================================== */

function renderTabular(args: {
  title: string
  facts: readonly string[]
  slice: TabularSlice
  budget: ContextBudget
  rowLabel: string
}): { text: string; notice: TruncationNotice | null } {
  const { slice, budget } = args
  const body = { columns: slice.columns, rows: slice.rows }
  const plan = planRowFit({
    available: slice.rows.length,
    total: slice.totalRows,
    sourceTruncated: slice.truncated,
    render: (n) => renderCsv(body, n, budget),
    budget,
  })
  const facts = [
    ...args.facts,
    `Included: ${args.rowLabel} · ${plan.rows.toLocaleString('en-US')} row(s) below.`,
    `Columns: ${columnLegend(slice.columns)}`,
    CSV_CONVENTION,
  ]
  return {
    text: renderDocument({
      title: args.title,
      facts,
      notices: [plan.notice],
      fence: { lang: 'csv', text: renderCsv(body, plan.rows, budget) },
    }),
    notice: plan.notice,
  }
}

/**
 * Compact rendering of a selection: `3-7, 12, 40-44`.
 * A hundred comma-separated integers is not something a reader parses.
 */
export function summarizeIndexes(sorted: readonly number[]): string {
  const runs: string[] = []
  let start: number | null = null
  let prev: number | null = null
  const flush = (): void => {
    if (start === null || prev === null) return
    runs.push(start === prev ? String(start) : `${start}-${prev}`)
  }
  for (const n of sorted) {
    if (start === null || prev === null) {
      start = n
      prev = n
      continue
    }
    if (n === prev + 1) {
      prev = n
      continue
    }
    flush()
    start = n
    prev = n
  }
  flush()
  return runs.join(', ')
}

function ok(
  a: ChatAttachment,
  uri: string,
  text: string,
  notice: TruncationNotice | null,
): ResolvedAttachment {
  return {
    attachmentId: a.id,
    uri,
    mimeType: 'text/markdown',
    text,
    notice,
    estimatedTokens: estimateTokens(text),
  }
}

function failed(a: ChatAttachment, error: PeekError): ResolvedAttachment {
  // The body says the same thing the error does, because the agent reads the
  // body and never sees `error`. An attachment that failed must still occupy a
  // block saying so — a missing block reads as "the user attached nothing".
  const text = renderDocument({
    title: `Attachment unavailable · ${a.label}`,
    prose: `peek could not resolve this attachment.\n\n**${error.code}**: ${error.message}`,
  })
  return {
    attachmentId: a.id,
    uri: `peek://attachment/${a.id}/unavailable`,
    mimeType: 'text/markdown',
    text,
    error,
    notice: null,
    estimatedTokens: estimateTokens(text),
  }
}

function overBudget(a: ChatAttachment): ResolvedAttachment {
  const notice: TruncationNotice = {
    unit: 'rows',
    included: 0,
    total: null,
    reason: 'promptBudget',
  }
  const text = renderDocument({
    title: `Attachment omitted · ${a.label}`,
    notices: [notice],
    prose: 'Send it on its own message to include it.',
  })
  return {
    attachmentId: a.id,
    uri: `peek://attachment/${a.id}/omitted`,
    mimeType: 'text/markdown',
    text,
    notice,
    estimatedTokens: estimateTokens(text),
  }
}

/** The connection behind a view, read from the snapshot. Chat views may have none. */
function viewConnId(source: ContextSource, viewId: import('@peek/core').ViewId): import('@peek/core').ConnId | null {
  const view = source.readView(viewId)
  if (!view) return null
  return 'connId' in view && view.connId !== undefined ? view.connId : null
}

/** Human-readable name for a descriptor, used for chips and for failure bodies. */
export function defaultAttachmentLabel(a: ChatAttachment): string {
  switch (a.kind) {
    case 'rows':
      return `${a.rowIndexes.length} selected row(s)`
    case 'result':
      return 'Query result'
    case 'cell':
      return `Cell ${a.column} (row ${a.rowIndex})`
    case 'schema':
      return `Structure of ${collectionRefLabel(a.ref)}`
    case 'query':
      return 'Query text'
    case 'workspace':
      return 'Workspace'
  }
}
