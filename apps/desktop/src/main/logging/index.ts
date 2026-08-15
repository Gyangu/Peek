/**
 * Assembly: the one place the four existing log channels finally have an end.
 *
 * ## What this owns
 *
 * - the **current level**, which is mutable at runtime (design §3.4bis) because
 *   the moment you want `debug` is always after the thing you wanted to debug
 * - a **ring** of recent records, which is what the panel reads
 * - the two **files**, which are what the user hands over
 *
 * ## Why both a ring and a file
 *
 * They answer different questions and neither can be derived from the other
 * cheaply. The panel filters by level, namespace and tag, so it wants records,
 * not text — reparsing `peek.log` to get them back would mean writing a parser
 * for a format whose whole purpose is being readable by a person. The file
 * outlives the process, which the ring cannot.
 *
 * The honest consequence, and it belongs in the UI copy rather than buried here:
 * **the panel shows this session.** Older sessions are in the files.
 */

import { join } from 'node:path'
import type { LogLevel, LogNamespace, LogRecord, TaggedLogger } from '@peek/core'
import { createLogger, formatLogLine, levelAtLeast, parseLogLevel } from '@peek/core'
import type { CommandLogEntry } from '../bus/command-log'
import { logsDir } from '../config/paths'
import { createLogFileWriter, type LogFileWriter } from './sink'
import { createScrubber, type Scrubber } from './scrub'

/** Diagnostics. 2 MiB × 5 = 10 MiB ceiling. */
const DIAGNOSTIC_FILE = 'peek.log'
const DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024
const DIAGNOSTIC_KEEP = 5

/**
 * The command audit. Bigger and fewer than diagnostics: entries are small,
 * uniform, and worth keeping longer — this is the stream PLAN §6 calls a
 * recording of the session.
 */
const AUDIT_FILE = 'commands.jsonl'
const AUDIT_MAX_BYTES = 4 * 1024 * 1024
const AUDIT_KEEP = 3

/**
 * How many diagnostic records the panel can look back over.
 *
 * Larger than the error centre's 100 and the Command log's 500 because this is
 * the densest of the three by an order of magnitude — one debug-level agent turn
 * alone can be dozens of records, and a ring that cannot hold one turn cannot
 * answer the question the whole feature exists for.
 */
export const LOG_RING_CAPACITY = 2000

export interface LoggingOptions {
  readonly configDir: string
  /** From `settings.json`. `undefined` means "use the default for this build". */
  readonly settingsLevel?: LogLevel
  /** `import.meta.env.DEV` — dev defaults to `debug`, packaged to `info`. */
  readonly isDev: boolean
  readonly env?: NodeJS.ProcessEnv
  /** Injectable for tests; production passes nothing and gets real files. */
  readonly writers?: { diagnostic: LogFileWriter; audit: LogFileWriter }
}

export interface Logging {
  /** A logger for one subsystem. Call `.with(id)` on it to stamp a correlation key. */
  logger(ns: LogNamespace): TaggedLogger
  /** What the panel reads. Newest last, like every other log surface in peek. */
  read(query?: { limit?: number; minLevel?: LogLevel; ns?: LogNamespace; tag?: string }): LogRecord[]
  level(): LogLevel
  setLevel(level: LogLevel): void
  /** Append one audit entry. Called by the Command Bus's log. */
  audit(entry: CommandLogEntry): void
  /** Register a literal secret so it is masked wherever it turns up. */
  rememberSecret(secret: string | null | undefined): void
  /**
   * `true` once the ring has evicted anything this session.
   *
   * Reported to the panel rather than kept private: a view showing the last 2000
   * of 50000 records is pixel-identical to one showing all 2000 that ever
   * existed, and only one of those two means "you have the whole story".
   */
  readonly truncated: boolean
  /** Flush both files. Safe to call more than once. */
  close(): void
  readonly diagnosticPath: string
  readonly auditPath: string
}

/**
 * Which level to start at, and why the environment variable does not persist.
 *
 * `PEEK_LOG_LEVEL` **overrides and is never written back**, exactly like
 * `PEEK_MCP_PORT` (PLAN §7): one integration run must not silently rewrite a
 * user's preference. A misspelt value is worth a word to stderr because somebody
 * typed it seconds ago and is waiting for it to take effect — unlike a misspelt
 * `settings.json`, which is answered by falling back.
 */
export function resolveInitialLevel(options: {
  settingsLevel?: LogLevel
  isDev: boolean
  env?: NodeJS.ProcessEnv
}): LogLevel {
  const raw = (options.env ?? process.env)['PEEK_LOG_LEVEL']
  if (raw !== undefined && raw !== '') {
    const parsed = parseLogLevel(raw)
    if (parsed !== null) return parsed
    console.warn(`[peek/app] PEEK_LOG_LEVEL=${raw} is not one of debug|info|warn|error; ignoring it`)
  }
  return options.settingsLevel ?? (options.isDev ? 'debug' : 'info')
}

export function createLogging(options: LoggingOptions): Logging {
  const dir = logsDir(options.configDir)
  const diagnosticPath = join(dir, DIAGNOSTIC_FILE)
  const auditPath = join(dir, AUDIT_FILE)
  const scrubber = createScrubber()

  let level = resolveInitialLevel(options)
  let evicted = false
  const ring: LogRecord[] = []

  const writers = options.writers ?? {
    diagnostic: createLogFileWriter({
      path: diagnosticPath,
      maxBytes: DIAGNOSTIC_MAX_BYTES,
      keep: DIAGNOSTIC_KEEP,
      onError: reportWriteFailure,
    }),
    audit: createLogFileWriter({
      path: auditPath,
      maxBytes: AUDIT_MAX_BYTES,
      keep: AUDIT_KEEP,
      onError: reportWriteFailure,
    }),
  }

  function sink(record: LogRecord): void {
    // Scrubbed once, before either destination — so the ring the panel shows and
    // the file the user sends are the same text, and a reader cannot be told
    // that the panel was safe but the file was not.
    const safe: LogRecord = {
      ...record,
      message: scrubber.scrub(record.message),
      ...(record.detail === undefined ? {} : { detail: scrubDetail(scrubber, record.detail) }),
    }
    ring.push(safe)
    if (ring.length > LOG_RING_CAPACITY) {
      ring.splice(0, ring.length - LOG_RING_CAPACITY)
      evicted = true
    }
    writers.diagnostic.write(formatLogLine(safe))
  }

  return {
    diagnosticPath,
    auditPath,
    get truncated() {
      return evicted
    },
    logger(ns) {
      return createLogger({ ns, sink, minLevel: () => level })
    },
    read(query) {
      const limit = query?.limit ?? 500
      const filtered = ring.filter((record) => {
        if (query?.minLevel !== undefined && !levelAtLeast(record.level, query.minLevel)) return false
        if (query?.ns !== undefined && record.ns !== query.ns) return false
        if (query?.tag !== undefined && record.tag !== query.tag) return false
        return true
      })
      // "The most recent N", oldest first — the same ordering `CommandLog.entries`
      // and the error centre both use, so the three tabs read the same direction.
      return filtered.slice(Math.max(0, filtered.length - limit))
    },
    level: () => level,
    setLevel(next) {
      level = next
    },
    audit(entry) {
      // One JSON object per line. Machine-first on purpose (design §4.3): this
      // is the stream that has to be replayable, and `input` is already redacted
      // by `redactCommandInput` before it reaches here.
      try {
        writers.audit.write(JSON.stringify(entry))
      } catch {
        // An entry that will not serialise is dropped rather than allowed to
        // throw inside `CommandLog.push`, which runs on the dispatch path of
        // every command in the app.
      }
    },
    rememberSecret(secret) {
      scrubber.remember(secret)
    },
    close() {
      writers.diagnostic.close()
      writers.audit.close()
    },
  }
}

let reportedWriteFailure = false

/**
 * Said once, to the console, and never through a logger.
 *
 * Routing this through the logging system would mean a failing disk generating a
 * log line that fails to write that generates a log line.
 */
function reportWriteFailure(error: unknown): void {
  if (reportedWriteFailure) return
  reportedWriteFailure = true
  console.error(
    '[peek/app] could not write to the log file; logging to disk is disabled for this session',
    error,
  )
}

/**
 * Scrub a detail without changing its shape.
 *
 * Strings are scrubbed directly. Anything else is scrubbed through its JSON so
 * that a secret sitting in a nested field is caught too, and it is handed back
 * as a **string** rather than reparsed: `formatLogLine` renders a string detail
 * verbatim, and reparsing would only invite the two representations to disagree.
 */
function scrubDetail(scrubber: Scrubber, detail: unknown): unknown {
  if (typeof detail === 'string') return scrubber.scrub(detail)
  if (detail instanceof Error) {
    const scrubbed = new Error(scrubber.scrub(detail.message))
    scrubbed.name = detail.name
    if (detail.stack !== undefined) scrubbed.stack = scrubber.scrub(detail.stack)
    return scrubbed
  }
  try {
    return scrubber.scrub(JSON.stringify(detail) ?? String(detail))
  } catch {
    return scrubber.scrub(String(detail))
  }
}
