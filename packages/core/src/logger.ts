/**
 * The logging contract: a level, a namespace, and one method.
 *
 * ## Why this is not a new invention
 *
 * peek already had four structured log channels before this file existed — the
 * driver host emits `{ connId, level, message, detail }`, the ACP manager emits
 * `{ level, message, detail }`, and `McpLogger` is the shape MCP tools and the
 * endpoint agent were already written against. What none of them had was an
 * **end**: all four terminated in `console.*`, which no user can retrieve.
 *
 * So this module is deliberately the smallest thing that can be that end. It
 * defines the record, the sink that swallows one, and a `createLogger` that
 * joins them — and `McpLogger` becomes an alias of `Logger` rather than a second
 * vocabulary for the same idea. See
 * `docs/design/2026-08-15-logging-and-audit.md` §3.2.
 *
 * ## Why there is no `fs` in here, and why that is load-bearing
 *
 * `packages/core` compiles with `types: []` — production code in core is not
 * allowed to see the node runtime, and that is a real constraint rather than a
 * convention (PLAN §11.2 records that adding one `process.env` fails the build).
 * Levels, formatting and filtering are pure and belong here; the half that opens
 * a file lives in `apps/desktop/src/main/logging/`.
 */

/* ================================================================== */
/* 1. Level                                                            */
/* ================================================================== */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Ordered weakest-first. Exported because both the settings parser and the
 * panel's level picker need to render the same four in the same order, and a
 * second hand-written list is how those two drift apart.
 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** `true` when `level` is at least as severe as `minimum`. */
export function levelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minimum]
}

/**
 * Parse a level from settings or an environment variable.
 *
 * `null` rather than a throw or a silent default, because the two callers want
 * different things from a bad value: `PEEK_LOG_LEVEL=verbose` should be said out
 * loud (somebody typed it just now and is waiting for it to work), while a
 * malformed `settings.json` should fall back and carry on. Returning the failure
 * lets each decide; baking one of them in here would force the other.
 */
export function parseLogLevel(raw: unknown): LogLevel | null {
  if (typeof raw !== 'string') return null
  const found = LOG_LEVELS.find((level) => level === raw)
  return found ?? null
}

/* ================================================================== */
/* 2. Namespace                                                        */
/* ================================================================== */

/**
 * Who is speaking. A closed union rather than a free string.
 *
 * These ten are not invented here — they are the prefixes four different files
 * had already hand-written (`[peek/mcp]`, `[peek/agent]`, `[peek/acp]`,
 * `[peek/driver]`, `[peek/renderer:…]`). Closing the set is what turns them from
 * a coincidence into something the panel can offer as a filter, and what stops
 * an eleventh spelling of `agent` from appearing in a log nobody can group.
 */
export type LogNamespace =
  /** Process lifecycle, window creation, settings — main's own voice. */
  | 'app'
  /** The Command Bus. */
  | 'bus'
  /** The Workspace store and its persistence. */
  | 'store'
  /** Connection manager: opening, closing, reconnecting. */
  | 'conn'
  /** A driver host (utilityProcess), one per connection. */
  | 'driver'
  /** A package host (utilityProcess), one per package. */
  | 'package'
  /** The MCP HTTP server and its tools. */
  | 'mcp'
  /** The endpoint chat backend: the agent loop, its events, its tools. */
  | 'agent'
  /** The ACP chat backend and the external agent process it spawns. */
  | 'acp'
  /** Forwarded from the window. */
  | 'renderer'

export const LOG_NAMESPACES: readonly LogNamespace[] = [
  'app', 'bus', 'store', 'conn', 'driver', 'package', 'mcp', 'agent', 'acp', 'renderer',
]

/* ================================================================== */
/* 3. Record and sink                                                  */
/* ================================================================== */

export interface LogRecord {
  /** Epoch milliseconds. */
  readonly ts: number
  readonly level: LogLevel
  readonly ns: LogNamespace
  readonly message: string
  /**
   * Anything that helps, rendered by `formatLogLine`. An `Error` keeps its
   * stack; everything else is JSON, and something that will not serialise
   * degrades to its `String()` rather than taking the log entry down with it.
   */
  readonly detail?: unknown
  /**
   * A correlation key: a `chatId`, a `connId`, a `resultId`.
   *
   * This field exists because the first question anyone asks of an agent failure
   * is "what happened *in that turn*", and answering it means collapsing thirty
   * interleaved lines down to the five that belong to one conversation. The
   * driver host was already passing `connId` alongside its log events before
   * this field existed — this generalises what that channel had proved useful.
   *
   * A free string rather than a branded union: it is read by humans, by `grep`,
   * and by one panel filter, and none of those three benefits from the
   * compiler knowing which kind of id it happens to be.
   */
  readonly tag?: string
}

/** Where a record goes. Implemented in main; a no-op everywhere else. */
export type LogSink = (record: LogRecord) => void

/**
 * The one method.
 *
 * `McpLogger` is an alias of this (see `mcp-tools.ts`), which is the whole point:
 * every call site already written against that interface — main's tool context,
 * a package's `contrib.mjs`, the endpoint loop — starts logging for real without
 * being touched.
 */
export interface Logger {
  log(level: LogLevel, message: string, detail?: unknown): void
}

/**
 * A logger that can hand out copies of itself bound to a correlation key.
 *
 * Separate from `Logger` on purpose. `Logger` is the *consumed* shape and stays
 * one method wide, so that every hand-written `{ log: () => {} }` stub in the
 * test suite keeps satisfying it; `TaggedLogger` is the *produced* shape, and
 * only `createLogger` returns one.
 */
export interface TaggedLogger extends Logger {
  /** A logger identical to this one, stamping `tag` on everything it writes. */
  with(tag: string): TaggedLogger
}

export interface LoggerOptions {
  readonly ns: LogNamespace
  readonly sink: LogSink
  /**
   * The current minimum level — a **getter**, not a value.
   *
   * The panel can change the level without a restart (design §3.4bis), and a
   * logger holding a copy of the level at construction time would keep filtering
   * against a number that stopped being true. Reading it per call is the price
   * of "turn on debug, then reproduce", which is the workflow the whole level
   * picker exists for.
   */
  readonly minLevel: () => LogLevel
  readonly tag?: string
}

export function createLogger(options: LoggerOptions): TaggedLogger {
  const { ns, sink, minLevel, tag } = options
  return {
    log(level, message, detail) {
      // Filtering here rather than in the sink so that a suppressed debug line
      // costs one comparison instead of an allocated record.
      if (!levelAtLeast(level, minLevel())) return
      sink({
        ts: Date.now(),
        level,
        ns,
        message,
        ...(detail === undefined ? {} : { detail }),
        ...(tag === undefined ? {} : { tag }),
      })
    },
    with(nextTag) {
      return createLogger({ ...options, tag: nextTag })
    },
  }
}

/** A logger that discards everything. For tests, and for a host with no sink yet. */
export const noopLogger: TaggedLogger = {
  log() {
    /* discarded */
  },
  with() {
    return noopLogger
  },
}

/* ================================================================== */
/* 4. Formatting                                                       */
/* ================================================================== */

/**
 * Render a record as the line that lands in `peek.log`.
 *
 * Deliberately **not** JSON and deliberately **not** localized, for the same
 * reason `formatEntry` in the error centre is neither: this text exists to be
 * pasted into an issue, where it has to read identically to whoever opens it.
 * The audit stream is the one that is machine-first, and it is a different file
 * (design §3.1).
 *
 * Layout — fixed-width level and namespace so a screenful of these aligns:
 *
 *     2026-08-15T09:14:02.113Z  WARN   agent   [chat_7f3a]  unknown:tool_stream
 *       { "type": "tool_stream" }
 */
export function formatLogLine(record: LogRecord): string {
  const ts = new Date(record.ts).toISOString()
  const level = record.level.toUpperCase().padEnd(5)
  const ns = record.ns.padEnd(8)
  const tag = record.tag === undefined ? '' : `[${record.tag}]  `
  const head = `${ts}  ${level}  ${ns}  ${tag}${record.message}`
  const detail = formatDetail(record.detail)
  return detail === null ? head : `${head}\n${indent(detail)}`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/**
 * `null` means "there was nothing to add", which is not the same as the detail
 * being the value `null` — a caller who logged `null` on purpose gets to see it.
 */
function formatDetail(detail: unknown): string | null {
  if (detail === undefined) return null
  if (typeof detail === 'string') return detail
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  try {
    const json = JSON.stringify(detail, null, 2)
    // `JSON.stringify` answers `undefined` for a function or a bare symbol.
    return json ?? String(detail)
  } catch {
    // Circular, or a BigInt. A log line must never be the thing that throws:
    // whatever this is, its `String()` is more use than an exception raised
    // inside somebody else's catch block.
    return String(detail)
  }
}
