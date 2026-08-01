import { ConnectionConfigSchema, redactConnectionConfig } from '@peek/core'
import type { CommandName, CommandSource, PeekErrorCode } from '@peek/core'

/**
 * The Command log (PLAN section 6: "the Command log is a recording of the
 * session by construction — replayable and testable").
 *
 * A ring buffer holding the last N entries. A human clicking a button and an AI
 * calling a tool land in the same log, told apart only by `source` — which is
 * also the verifiable evidence that both really do travel the same channel.
 */

export const COMMAND_LOG_CAPACITY = 500

export interface CommandLogEntry {
  /** Per-process counter, starting at 1 */
  seq: number
  commandId: string
  ts: number
  source: CommandSource
  name: CommandName
  /** Redacted input (a conn.open password never reaches disk or this log) */
  input: unknown
  ok: boolean
  /** The rev after the change landed */
  rev: number
  elapsedMs: number
  errorCode?: PeekErrorCode
  errorMessage?: string
}

export type CommandLogInput = Omit<CommandLogEntry, 'seq'>

export class CommandLog {
  readonly #buffer: (CommandLogEntry | undefined)[]
  readonly #capacity: number
  #writeIndex = 0
  #count = 0
  #seq = 0

  constructor(capacity: number = COMMAND_LOG_CAPACITY) {
    this.#capacity = Math.max(1, capacity)
    this.#buffer = new Array<CommandLogEntry | undefined>(this.#capacity)
  }

  push(entry: CommandLogInput): CommandLogEntry {
    this.#seq += 1
    const full: CommandLogEntry = { ...entry, seq: this.#seq }
    this.#buffer[this.#writeIndex] = full
    this.#writeIndex = (this.#writeIndex + 1) % this.#capacity
    if (this.#count < this.#capacity) this.#count += 1
    return full
  }

  /** Oldest first; `limit` means "the most recent N". */
  entries(limit?: number): CommandLogEntry[] {
    const out: CommandLogEntry[] = []
    const start = (this.#writeIndex - this.#count + this.#capacity) % this.#capacity
    for (let i = 0; i < this.#count; i += 1) {
      const entry = this.#buffer[(start + i) % this.#capacity]
      if (entry) out.push(entry)
    }
    return limit !== undefined && limit < out.length ? out.slice(out.length - limit) : out
  }

  get size(): number {
    return this.#count
  }

  get capacity(): number {
    return this.#capacity
  }

  clear(): void {
    this.#buffer.fill(undefined)
    this.#writeIndex = 0
    this.#count = 0
  }
}

/**
 * How much of a chat prompt is kept in the log. The buffer holds
 * `COMMAND_LOG_CAPACITY` entries in memory, and a prompt may be a hundred
 * kilobytes, so the untruncated version turns a debugging aid into a
 * multi-megabyte retention of whatever the user typed.
 */
const MAX_LOGGED_PROMPT_CHARS = 500

/**
 * Redact command input.
 *
 * Two cases, and they are different kinds of problem. A `conn.open` config
 * carries a cleartext password, which must never reach the log at all. A
 * `chat.send` prompt is not a secret but is unbounded, and the log is a fixed-size
 * ring held in memory — so it is truncated rather than removed, because knowing
 * *what was asked* is most of the value of having the entry.
 *
 * Parsing through core's schema rather than casting also drops malformed input for
 * free.
 */
export function redactCommandInput(name: CommandName, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input

  if (name === 'conn.open') {
    const record: Record<string, unknown> = { ...(input as Record<string, unknown>) }
    const parsed = ConnectionConfigSchema.safeParse(record['config'])
    if (parsed.success) record['config'] = redactConnectionConfig(parsed.data)
    else delete record['config']
    return record
  }

  if (name === 'chat.send') {
    const record: Record<string, unknown> = { ...(input as Record<string, unknown>) }
    const text = record['text']
    if (typeof text === 'string' && text.length > MAX_LOGGED_PROMPT_CHARS) {
      record['text'] = `${text.slice(0, MAX_LOGGED_PROMPT_CHARS)}… (${String(text.length)} chars)`
    }
    return record
  }

  return input
}
