/**
 * The end of the line: a buffered, size-rotating append-only file.
 *
 * ## Why hand-written rather than `pino` / `electron-log`
 *
 * `pino` is JSON-first, and the diagnostic stream's first reader is a person
 * pasting it into an issue. `electron-log` ships its own renderer→main IPC
 * forwarding — and peek's forwarding chain was already running before this
 * existed (design §3.3), so adopting it would mean two paths doing the same job
 * to the same console messages.
 *
 * The honest cost of writing it: rotation's edge cases are exactly what those
 * libraries are worth paying for. Two of the three are mitigated by structure
 * rather than by care — **main is the only writer** (every other process reaches
 * this through stdio forwarding), so concurrent appends cannot happen. The two
 * that remain are the file vanishing under us and the write failing, and both
 * are handled below rather than hoped about.
 *
 * ## Why buffered
 *
 * A debug-level agent turn emits a line per streamed event. One `writeSync` per
 * line would put main's event loop in the middle of that, and §8's performance
 * budget has no allowance set aside for logging. So lines accumulate and land
 * every `flushIntervalMs`, or as soon as they exceed `maxBufferBytes`.
 *
 * The cost is stated rather than hidden: **a hard crash loses up to one flush
 * interval.** Ordinary exits do not — `close()` is called from `before-quit` and
 * from `process.on('exit')`, both of which can still do synchronous IO.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, extname, join, basename } from 'node:path'

/** Directory mode: the same 0700 `mcp.json`'s directory gets, for the same reason. */
const DIR_MODE = 0o700
/** File mode: 0600. A log can hold connection strings, table names and query text. */
const FILE_MODE = 0o600

export interface LogFileWriterOptions {
  readonly path: string
  /** Roll over once the live file would exceed this. */
  readonly maxBytes: number
  /** How many files to keep in total, the live one included. `3` means `x.log`, `x.1.log`, `x.2.log`. */
  readonly keep: number
  readonly flushIntervalMs?: number
  readonly maxBufferBytes?: number
  /**
   * Told about a write that failed.
   *
   * **Must not log.** It is called from inside the logging machinery, so a
   * handler that logs turns a full disk into unbounded recursion. main passes
   * something that writes to `console.error` once and then stays quiet.
   */
  readonly onError?: (error: unknown) => void
}

export interface LogFileWriter {
  readonly path: string
  write(line: string): void
  /** Write what is buffered, now. Synchronous. */
  flush(): void
  /** Flush and stop the timer. Idempotent. */
  close(): void
}

export function createLogFileWriter(options: LogFileWriterOptions): LogFileWriter {
  const flushIntervalMs = options.flushIntervalMs ?? 200
  const maxBufferBytes = options.maxBufferBytes ?? 16 * 1024

  let buffer: string[] = []
  let bufferBytes = 0
  let timer: NodeJS.Timeout | null = null
  let closed = false
  /**
   * Bytes in the live file, tracked rather than `statSync`-ed on every flush.
   * `-1` means "not known yet"; it is re-derived from the filesystem on the next
   * flush, which is also how an externally deleted file heals (see `sizeOf`).
   */
  let liveBytes = -1
  /**
   * Reported at most once. A disk that is full fails every subsequent write, and
   * a handler that speaks every time turns one problem into a second one.
   */
  let reportedError = false

  function report(error: unknown): void {
    if (reportedError) return
    reportedError = true
    options.onError?.(error)
  }

  function sizeOf(): number {
    if (liveBytes >= 0) return liveBytes
    try {
      liveBytes = existsSync(options.path) ? statSync(options.path).size : 0
    } catch {
      // Unreadable is treated as empty: the worst case is that rotation happens
      // one file-length late, which beats refusing to log.
      liveBytes = 0
    }
    return liveBytes
  }

  function ensureDir(): void {
    mkdirSync(dirname(options.path), { recursive: true, mode: DIR_MODE })
  }

  /**
   * Shift the live file to `.1`, `.1` to `.2`, and drop whatever falls off.
   *
   * Renames rather than copies, so a reader holding the old file keeps reading a
   * complete one. `keep - 1` is the highest suffix that survives, which is why
   * the loop starts by deleting it.
   */
  function rotate(): void {
    const oldest = rotatedPath(options.path, options.keep - 1)
    try {
      if (existsSync(oldest)) unlinkSync(oldest)
    } catch {
      // Left behind; the rename below will overwrite it on most platforms, and
      // failing to log because an old log will not delete is the wrong trade.
    }
    for (let index = options.keep - 2; index >= 1; index -= 1) {
      const from = rotatedPath(options.path, index)
      const to = rotatedPath(options.path, index + 1)
      try {
        if (existsSync(from)) renameSync(from, to)
      } catch {
        /* same reasoning as above */
      }
    }
    try {
      if (existsSync(options.path)) renameSync(options.path, rotatedPath(options.path, 1))
    } catch {
      /* same */
    }
    liveBytes = 0
  }

  function writeChunk(text: string): void {
    const bytes = Buffer.byteLength(text)
    ensureDir()

    // Checked before the append rather than after, so the live file crosses the
    // limit by at most the size of one flush instead of growing until noticed.
    if (sizeOf() > 0 && sizeOf() + bytes > options.maxBytes) rotate()

    const fresh = !existsSync(options.path)
    appendFileSync(options.path, text, { encoding: 'utf8', mode: FILE_MODE })
    if (fresh) {
      // `mode` on `appendFileSync` only applies when the file is created, and it
      // is masked by the process umask on top of that. An explicit chmod is what
      // makes 0600 true rather than aspirational.
      try {
        chmodSync(options.path, FILE_MODE)
      } catch {
        /* a log that is readable is better than no log */
      }
      // Someone deleted it under us; whatever we thought it held is gone.
      liveBytes = 0
    }
    liveBytes = sizeOf() + bytes
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (buffer.length === 0) return
    const text = buffer.join('')
    buffer = []
    bufferBytes = 0
    try {
      writeChunk(text)
    } catch (error) {
      // Deliberately swallowed past the one report. Logging must never be the
      // thing that takes the app down — it runs inside other people's catch
      // blocks, and a throw from here would replace a diagnosable failure with
      // an undiagnosable one.
      report(error)
    }
  }

  return {
    path: options.path,
    write(line) {
      if (closed) return
      const text = line.endsWith('\n') ? line : `${line}\n`
      buffer.push(text)
      bufferBytes += text.length
      if (bufferBytes >= maxBufferBytes) {
        flush()
        return
      }
      if (timer === null) {
        timer = setTimeout(flush, flushIntervalMs)
        // Without this an idle app with one buffered line would refuse to quit
        // for as long as the timer is pending.
        timer.unref()
      }
    },
    flush,
    close() {
      flush()
      closed = true
    },
  }
}

/**
 * `peek.log` + 1 → `peek.1.log`.
 *
 * The number goes before the extension rather than after so that the rotated
 * files keep opening in whatever the user has associated with `.log` and
 * `.jsonl` — a `peek.log.1` is a file most editors treat as binary.
 */
export function rotatedPath(path: string, index: number): string {
  const dir = dirname(path)
  const ext = extname(path)
  const stem = basename(path, ext)
  return join(dir, `${stem}.${String(index)}${ext}`)
}
