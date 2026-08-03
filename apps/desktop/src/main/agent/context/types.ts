/**
 * The port this module reads through.
 *
 * ## Why a port and not direct access
 *
 * PLAN section 3 splits the planes: result rows travel from the driver host to
 * the renderer over a MessagePort and **main never holds them**. So the process
 * that has to serialize "the rows the user selected" is the one process that does
 * not have those rows. There are only two ways to get them — ask the renderer
 * (which is what `ResultRowsBroker` already does for MCP's `run_query`) or ask
 * the driver again — and both are integration concerns with their own lifetimes,
 * timeouts and failure modes.
 *
 * Defining them as a port keeps three things true:
 *
 * - every function in this module is **pure and testable** without an Electron
 *   window, a driver host or a live database;
 * - the ACP host owns the wiring, so this module cannot accidentally acquire a
 *   second, divergent way of reaching the renderer;
 * - a source that cannot answer says so in `PeekError` terms, and
 *   `AttachmentPayload.error` carries that to the user instead of silently
 *   sending an empty table.
 *
 * ## Failure is a first-class outcome here
 *
 * An attachment is a **descriptor resolved at send time** (see `ChatAttachment`),
 * and by then the thing it names may be gone: the renderer's result cache is an
 * LRU, the view may be closed, the connection may have dropped. That is the
 * design working, not a bug — but it means every method below is allowed to
 * reject, and `resolve.ts` turns a rejection into a payload that *says* it failed
 * rather than one that quietly carries nothing.
 */

import type {
  CollectionRef,
  CollectionSchemaInfo,
  ColumnDef,
  ConnId,
  PeekedValue,
  ResultId,
  ValueRef,
  ViewId,
  ViewState,
  WorkspaceSnapshot,
} from '@peek/core'

/** Rows read back out of the renderer's cache. Mirrors MCP's `ResultRowsSlice`. */
export interface TabularSlice {
  columns: ColumnDef[]
  /** Row-major, in `columns` order. */
  rows: unknown[][]
  /**
   * Rows the result set is known to hold. While a stream is still running this is
   * what has arrived so far, which is why `planRowFit` accepts `null` for
   * "unknown" and callers must not treat this as final.
   */
  totalRows: number
  /** The source itself is incomplete — row limit, backpressure pause, or eviction. */
  truncated: boolean
}

export interface ReadResultRowsRequest {
  resultId: ResultId
  /** First row to read (absolute index within the result set). */
  offset?: number
  /** Maximum rows to return. */
  limit: number
  timeoutMs?: number
}

/**
 * Everything `resolve.ts` needs from the rest of peek.
 *
 * The two synchronous members are synchronous on purpose: main holds the
 * Workspace as its source of truth, so reading a view or a snapshot is a map
 * lookup, and making it a promise would invite a caller to await it inside the
 * `prompt()` path for no reason.
 */
export interface ContextSource {
  /** Rows from the renderer's result cache. Rejects when the result is gone. */
  readResultRows(req: ReadResultRowsRequest): Promise<TabularSlice>
  /** A collection's structure, straight from the driver. */
  describeCollection(req: { connId: ConnId; ref: CollectionRef; timeoutMs?: number }): Promise<CollectionSchemaInfo>
  /**
   * One large value in full — the point of a `cell` attachment.
   *
   * Optional: a driver without the `valuePeek` capability simply has no way to
   * answer, and a cell attachment then falls back to whatever the row carried
   * (a preview), saying so in the document.
   */
  peekValue?(req: { connId: ConnId; ref: ValueRef; timeoutMs?: number }): Promise<PeekedValue>
  /** A view from main's Workspace, for the SQL text of a query view. */
  readView(viewId: ViewId): ViewState | null
  /** The redacted outward-facing snapshot — the same one `read_workspace` returns. */
  getSnapshot(): WorkspaceSnapshot
}
