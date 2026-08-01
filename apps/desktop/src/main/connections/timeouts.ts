/**
 * Every timeout peek enforces, in one place.
 *
 * Two families live here, and they answer different questions:
 *
 * - **Stage timeouts** (`Timeouts`) bound one leg of the driver-host protocol:
 *   spawn → ready, the connect RPC, an ordinary control-plane RPC, the *start*
 *   phase of a fetch, the cancel RPC, shutdown. They protect main from a wedged
 *   host process and have nothing to say about how long a query may run.
 * - **Execution timeouts** (`ExecutionTimeouts`) bound the whole fetch: from the
 *   moment the request leaves main to the moment the last chunk lands. A caller
 *   may pass its own `timeoutMs`; these are the defaults used when it does not,
 *   which is what makes "the UI cannot set a timeout" (M6) go away without every
 *   button in the window having to grow a field.
 *
 * The values are mutable through `setTimeoutSettings` and readable through
 * `getTimeoutSettings`. That split is deliberate: this module owns the numbers
 * and their validation, the settings UI (owned elsewhere) owns *where they are
 * persisted and how they are edited*, and neither has to know the other exists.
 * Nothing here ever reads a file or touches Electron.
 */

/* ================================================================== */
/* Shapes                                                              */
/* ================================================================== */

/** Stage timeouts for the driver-host protocol. */
export interface Timeouts {
  /** From spawn to the ready event */
  readyMs: number
  /** The connect RPC (dial + handshake + fetch serverInfo) */
  connectMs: number
  /** Ordinary control-plane RPCs (introspect / peek / keyvalue) */
  rpcMs: number
  /** Limit on the start phase of a query or scan; when the caller supplies timeoutMs, use timeoutMs plus the grace period */
  queryStartMs: number
  /** Extra grace given to the driver to wind down when the caller supplied timeoutMs */
  queryGraceMs: number
  /** The cancel RPC: past this, escalate to killing the process */
  cancelMs: number
  /** disconnect RPC */
  disconnectMs: number
  /** shutdown RPC */
  shutdownMs: number
  /** How long to wait after kill for the process to actually exit */
  exitMs: number
}

/**
 * Whole-fetch deadlines, applied when the caller passes no `timeoutMs`.
 *
 * `0` means **no deadline** — the honest way to say "let it run", and the reason
 * these are validated as non-negative rather than positive.
 */
export interface ExecutionTimeouts {
  /** Free-form query (`query.run`) */
  queryMs: number
  /** Collection scan (`collection.scan`) */
  scanMs: number
  /** Vector search (`vector.search`) */
  vectorSearchMs: number
}

export type TimeoutSettings = Timeouts & ExecutionTimeouts

/** Which execution budget a fetch draws on. */
export type ExecutionKind = 'query' | 'scan' | 'vectorSearch'

/* ================================================================== */
/* Defaults                                                            */
/* ================================================================== */

export const DEFAULT_TIMEOUTS: Timeouts = {
  readyMs: 10_000,
  connectMs: 15_000,
  rpcMs: 30_000,
  queryStartMs: 60_000,
  queryGraceMs: 5_000,
  cancelMs: 2_000,
  disconnectMs: 5_000,
  shutdownMs: 3_000,
  exitMs: 3_000,
}

/**
 * Two minutes for anything that streams rows, one for a vector search.
 *
 * Why a default at all, when peek used to have none: without one a runaway query
 * has exactly two ways to stop — the user notices, or the backpressure idle
 * timeout fires 60s after the viewport stops moving. Neither covers "the server
 * is thinking and no rows have arrived", which is the shape most runaway queries
 * actually have. Why not shorter: a deliberate analytical query over a large
 * table routinely takes tens of seconds, and a default that kills those would
 * train people to raise it everywhere, which is worse than not having one.
 */
export const DEFAULT_EXECUTION_TIMEOUTS: ExecutionTimeouts = {
  queryMs: 120_000,
  scanMs: 120_000,
  vectorSearchMs: 60_000,
}

const DEFAULT_SETTINGS: TimeoutSettings = { ...DEFAULT_TIMEOUTS, ...DEFAULT_EXECUTION_TIMEOUTS }

const STAGE_KEYS = Object.keys(DEFAULT_TIMEOUTS) as (keyof Timeouts)[]
const EXECUTION_KEYS = Object.keys(DEFAULT_EXECUTION_TIMEOUTS) as (keyof ExecutionTimeouts)[]

/** Ceiling on any single value (~1 hour), so a typo cannot disable a stage timeout outright. */
const MAX_TIMEOUT_MS = 3_600_000

/* ================================================================== */
/* The mutable global settings                                         */
/* ================================================================== */

let current: TimeoutSettings = { ...DEFAULT_SETTINGS }

/** Per-connection execution overrides, keyed by ConnId (kept as a string so this module needs no id types). */
const perConnection = new Map<string, Partial<ExecutionTimeouts>>()

const watchers = new Set<(settings: Readonly<TimeoutSettings>) => void>()

/** The settings in force. The returned object is a copy; mutating it changes nothing. */
export function getTimeoutSettings(): Readonly<TimeoutSettings> {
  return { ...current }
}

/**
 * Apply a partial change.
 *
 * Invalid entries are **dropped rather than thrown**: this is fed by a settings
 * form and by whatever the user last persisted, and one bad number must not stop
 * the other eight from applying — nor leave the app with no timeouts at all.
 * The return value is what actually took effect, so a caller that wants to report
 * "we ignored that" can diff it against what it asked for.
 */
export function setTimeoutSettings(patch: Partial<TimeoutSettings>): Readonly<TimeoutSettings> {
  const next: TimeoutSettings = { ...current }
  for (const key of STAGE_KEYS) {
    const value = patch[key]
    // A stage timeout of 0 would mean "give the host process no time at all",
    // which is not a configuration anybody wants; only execution budgets may be
    // switched off.
    if (isValidMs(value, 1)) next[key] = value
  }
  for (const key of EXECUTION_KEYS) {
    const value = patch[key]
    if (isValidMs(value, 0)) next[key] = value
  }
  current = next
  notifyWatchers()
  return { ...current }
}

/** Back to the built-in defaults, and drop every per-connection override. */
export function resetTimeoutSettings(): void {
  current = { ...DEFAULT_SETTINGS }
  perConnection.clear()
  notifyWatchers()
}

/**
 * Override the execution budgets for one connection.
 *
 * A connection-level knob rather than a view-level one because a budget belongs
 * to the thing that is slow: "queries against this warehouse take minutes" is a
 * fact about the warehouse, not about the pane it is shown in. Pass an empty
 * patch — or call `clearConnectionTimeouts` — to fall back to the global values.
 */
export function setConnectionTimeouts(connId: string, patch: Partial<ExecutionTimeouts>): void {
  const kept: Partial<ExecutionTimeouts> = {}
  for (const key of EXECUTION_KEYS) {
    const value = patch[key]
    if (isValidMs(value, 0)) kept[key] = value
  }
  if (Object.keys(kept).length === 0) perConnection.delete(connId)
  else perConnection.set(connId, kept)
  notifyWatchers()
}

export function clearConnectionTimeouts(connId: string): void {
  if (perConnection.delete(connId)) notifyWatchers()
}

/** The overrides in force for one connection (empty when it has none). */
export function getConnectionTimeouts(connId: string): Readonly<Partial<ExecutionTimeouts>> {
  return { ...(perConnection.get(connId) ?? {}) }
}

/**
 * The whole-fetch deadline for one request: the caller's own `timeoutMs` wins,
 * then the connection override, then the global default. `undefined` means no
 * deadline at all, which is what a configured `0` resolves to.
 */
export function resolveExecutionTimeout(
  connId: string,
  kind: ExecutionKind,
  explicitMs?: number,
): number | undefined {
  if (explicitMs !== undefined && explicitMs > 0) return explicitMs
  // An explicit 0 is a caller saying "no deadline", and it must beat the default.
  if (explicitMs === 0) return undefined
  const key = EXECUTION_KEY_OF[kind]
  const override = perConnection.get(connId)?.[key]
  const ms = override ?? current[key]
  return ms > 0 ? ms : undefined
}

const EXECUTION_KEY_OF: Record<ExecutionKind, keyof ExecutionTimeouts> = {
  query: 'queryMs',
  scan: 'scanMs',
  vectorSearch: 'vectorSearchMs',
}

/** Watch for changes (the settings UI edits, everything else reacts). Returns an unsubscribe. */
export function subscribeTimeoutSettings(cb: (settings: Readonly<TimeoutSettings>) => void): () => void {
  watchers.add(cb)
  return () => {
    watchers.delete(cb)
  }
}

function notifyWatchers(): void {
  const snapshot = getTimeoutSettings()
  for (const cb of watchers) cb(snapshot)
}

function isValidMs(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= MAX_TIMEOUT_MS
}
