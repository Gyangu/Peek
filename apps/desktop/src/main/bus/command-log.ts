import { redactConnectionConfig } from '@peek/core'
import { parseConnectionConfig, redactRulesFor } from '../../drivers/manifests'
import type { CommandLogEntry, CommandName } from '@peek/core'

/**
 * The Command log (PLAN section 6: "the Command log is a recording of the
 * session by construction — replayable and testable").
 *
 * A ring buffer holding the last N entries. A human clicking a button and an AI
 * calling a tool land in the same log, told apart only by `source` — which is
 * also the verifiable evidence that both really do travel the same channel.
 *
 * "Replayable" was aspirational for as long as the ring was all there was: a
 * recording that a process exit erases is not one. `sink` is what makes the
 * sentence true — main hands in a writer for `~/.peek/logs/commands.jsonl`, and
 * the entry is on disk as well as in memory. See
 * `docs/design/2026-08-15-logging-and-audit.md` §3.1.
 *
 * `CommandLogEntry` itself moved to core, because the panel renders these and
 * they now cross the process boundary.
 */

export const COMMAND_LOG_CAPACITY = 500

export type { CommandLogEntry }

export type CommandLogInput = Omit<CommandLogEntry, 'seq'>

/**
 * Commands that are not recorded.
 *
 * `log.*` reads the log, and the panel polls it while it is open — recording
 * those reads means the audit fills with evidence of itself being read, at two
 * entries per second, evicting the commands somebody opened it to look at.
 *
 * **`state.read` is deliberately not in here**, even though it is also read-only
 * and also called on a timer by some clients: it is an external client reading
 * peek's state, which is a fact about the session worth keeping. The rule is not
 * "read-only commands are boring", it is "a command whose only caller is this
 * log's own viewer cannot be evidence".
 */
const UNRECORDED: ReadonlySet<CommandName> = new Set<CommandName>(['log.read', 'log.readCommands'])

export class CommandLog {
  readonly #buffer: (CommandLogEntry | undefined)[]
  readonly #capacity: number
  readonly #sink: ((entry: CommandLogEntry) => void) | null
  #writeIndex = 0
  #count = 0
  #seq = 0

  constructor(capacity: number = COMMAND_LOG_CAPACITY, sink?: (entry: CommandLogEntry) => void) {
    this.#capacity = Math.max(1, capacity)
    this.#buffer = new Array<CommandLogEntry | undefined>(this.#capacity)
    this.#sink = sink ?? null
  }

  /**
   * Record one command. Returns the stored entry, or `null` when the command is
   * one this log does not keep.
   */
  push(entry: CommandLogInput): CommandLogEntry | null {
    if (UNRECORDED.has(entry.name)) return null
    this.#seq += 1
    const full: CommandLogEntry = { ...entry, seq: this.#seq }
    this.#buffer[this.#writeIndex] = full
    this.#writeIndex = (this.#writeIndex + 1) % this.#capacity
    if (this.#count < this.#capacity) this.#count += 1
    // After the ring, so a sink that throws cannot cost the in-memory entry.
    // (main's does not throw — it buffers — but this class must not depend on
    // the good manners of whoever is injected into it.)
    try {
      this.#sink?.(full)
    } catch {
      /* a log that will not persist is still a log */
    }
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
 * Parsing through the registry rather than casting also drops malformed input for
 * free — and a config whose driver peek has no manifest for, which core's schema
 * alone cannot recognise and whose redaction rules would therefore be empty.
 */
export function redactCommandInput(name: CommandName, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input

  if (name === 'conn.open') {
    const record: Record<string, unknown> = { ...(input as Record<string, unknown>) }
    const config = parseConnectionConfig(record['config'], 'keep')
    if (config !== null) {
      record['config'] = redactConnectionConfig(config, redactRulesFor(config.driverId))
    } else {
      delete record['config']
    }
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
