import { z } from 'zod'

/* ==================================================================
 * The per-view channel between the window and a self-drawn package view.
 *
 * A Tier C package (`docs/design/2026-08-03-plugin-architecture.md` §2.6) draws
 * itself inside an iframe on its own `peek-package://<id>` origin. That origin is
 * the security boundary, and it is a real one: the frame gets no preload, so
 * `window.peek` does not exist there, and its document CSP carries
 * `connect-src 'none'`, so it has no network. **One MessagePort is its entire
 * I/O**, and this file is everything that may travel over it.
 *
 * ## Why the protocol is this small
 *
 * Every message here was added because something concrete could not be done
 * without it. The list is deliberately not "whatever a view might want":
 *
 * - the frame **cannot** open a view, run a statement, read another connection,
 *   or reach any Command. The one thing it can change is its own view's state
 *   (`patch`), which the kernel then feeds back through the registration's
 *   `autoFetch` — so the *statement* is always composed by the package's
 *   registration, which runs in main, never by the frame.
 * - the frame **cannot** ask for more data. It receives what the host decides to
 *   send. There is no `fetchMore`, because a frame that could pull would be
 *   outside the kernel's backpressure and deadline accounting.
 *
 * ## Why zod on one side only
 *
 * The host validates everything arriving from the frame (`parsePackageViewClientMessage`),
 * because a compromised or simply buggy frame is the untrusted end. The frame is
 * given **types only** — it imports these declarations, not this module, so the
 * package bundle carries no zod and shares no chunk with the window. See
 * `packages/db-neo4j/ui/` for the one that exists today.
 * ================================================================== */

/**
 * The most rows the host will ever put in one `data` message.
 *
 * A cap, not a page size: there is no "next page" message, on purpose. A
 * self-drawn view is for data that is not table-shaped — a node-edge graph, a
 * time series — and every one of those becomes unreadable long before it becomes
 * slow. Neo4j Browser caps its own canvas at 300 nodes for exactly this reason.
 *
 * The cap is also what makes §2.6's chunk-level fan-out unnecessary for now: at
 * this size the host sends **one bounded snapshot**, so there is no per-chunk
 * structured clone and none of the 2–4× regression that design was priced for.
 * `truncated` is what keeps that honest — see below.
 */
export const PACKAGE_MAX_ROWS = 2000

export type PackageTheme = 'light' | 'dark'

/** What the host knows about the view's fetch, in the frame's vocabulary. */
export const PackageDataStatusSchema = z.enum(['idle', 'loading', 'done', 'error'])
export type PackageDataStatus = z.infer<typeof PackageDataStatusSchema>

/* ------------------------------------------------------------------ */
/* Host → frame                                                        */
/* ------------------------------------------------------------------ */

export interface PackageInitMessage {
  t: 'init'
  /** The view this frame is drawing. Echoed back in nothing — it is for the frame's own logging. */
  viewId: string
  packageKind: string
  state: Readonly<Record<string, unknown>>
  /** BCP-47, so a frame can localize its own chrome. */
  locale: string
  theme: PackageTheme
}

export interface PackageStateMessage {
  t: 'state'
  state: Readonly<Record<string, unknown>>
}

export interface PackageThemeMessage {
  t: 'theme'
  theme: PackageTheme
}

/**
 * One bounded snapshot of the view's result set.
 *
 * Rows are **row-major and plain**, not the columnar `ChunkFrame` the window
 * uses: the frame has no `resultCache`, no `vscroll` and no chunk assembler, and
 * shipping it a format it would have to reimplement in order to read is a cost
 * with no buyer. The window already holds the assembled rows; handing over a
 * slice of them is the cheap direction.
 *
 * `truncated` is not advisory. §2.6's rule is that loss must be loud, and this is
 * where that lands for Tier C: a frame that receives `truncated: true` and draws
 * as if it had everything is the failure this field exists to make impossible to
 * miss.
 */
export interface PackageDataMessage {
  t: 'data'
  status: PackageDataStatus
  /** Column names, in the order each row's cells are in. */
  columns: readonly string[]
  rows: readonly (readonly unknown[])[]
  /** How many rows the result actually has, which may be more than `rows.length`. */
  rowCount: number
  /** Set when `rows` is a prefix — either past `PACKAGE_MAX_ROWS`, or the driver truncated. */
  truncated: boolean
  /** Present only with `status: 'error'`; already localized-free English, like every PeekError message. */
  error?: string
}

export type PackageViewHostMessage =
  PackageInitMessage | PackageStateMessage | PackageThemeMessage | PackageDataMessage

/* ------------------------------------------------------------------ */
/* Frame → host                                                        */
/* ------------------------------------------------------------------ */

/**
 * The frame finished booting and is ready for `init`.
 *
 * The handshake runs this way round because the port arrives via
 * `window.postMessage` on the frame's `load`, and a frame that had not yet
 * installed its `onmessage` would drop whatever the host sent first.
 */
export const PackageReadyMessageSchema = z.object({ t: z.literal('ready') })

/**
 * Change this view's own state. Nothing else.
 *
 * Shaped exactly like the `package` member of `ViewPatch` because that is what the
 * host turns it into: a `view.update` command. It therefore inherits that
 * command's semantics for free — shallow merge, `null` deletes a key, and a
 * change re-runs the registration's `autoFetch`.
 */
export const PackagePatchMessageSchema = z.object({
  t: z.literal('patch'),
  state: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
})

/** The frame reporting its own trouble, so it reaches the error centre instead of a console nobody opens. */
export const PackageErrorMessageSchema = z.object({
  t: z.literal('error'),
  message: z.string().max(2000),
})

export const PackageViewClientMessageSchema = z.discriminatedUnion('t', [
  PackageReadyMessageSchema,
  PackagePatchMessageSchema,
  PackageErrorMessageSchema,
])

export type PackageViewClientMessage = z.infer<typeof PackageViewClientMessageSchema>
export type PackagePatchMessage = z.infer<typeof PackagePatchMessageSchema>

/**
 * Narrow one message off the port, or return null.
 *
 * Null rather than a throw, and the caller drops the message: a frame that sends
 * nonsense is a broken package, not a broken window, and taking the window down
 * with it would be the wrong blast radius. The host counts the drops so a package
 * that only ever sends nonsense is still visible.
 */
export function parsePackageViewClientMessage(data: unknown): PackageViewClientMessage | null {
  const parsed = PackageViewClientMessageSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}
