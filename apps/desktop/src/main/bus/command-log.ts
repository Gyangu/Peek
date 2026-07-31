import { ConnectionConfigSchema, redactConnectionConfig } from '@peek/core'
import type { CommandName, CommandSource, PeekErrorCode } from '@peek/core'

/**
 * Command 日志（PLAN 第 6 节："Command 日志天然是操作录制，可回放可测试"）。
 *
 * 环形缓冲，只留最近 N 条。人点按钮和 AI 发工具调用会落在同一条日志里，
 * 靠 source 区分 —— 这也是"两者走同一条通道"这件事的可验证证据。
 */

export const COMMAND_LOG_CAPACITY = 500

export interface CommandLogEntry {
  /** 进程内自增，从 1 开始 */
  seq: number
  commandId: string
  ts: number
  source: CommandSource
  name: CommandName
  /** 已脱敏的入参（conn.open 的口令不会落盘/落日志） */
  input: unknown
  ok: boolean
  /** 落地后的 rev */
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

  /** 按时间正序返回；limit 给的是"最近多少条" */
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
 * 入参脱敏：conn.open 的 config 含明文口令，绝不能进日志。
 * 用 core 的 schema 解析而不是硬转类型，顺便过滤掉形状不对的输入。
 */
export function redactCommandInput(name: CommandName, input: unknown): unknown {
  if (name !== 'conn.open') return input
  if (typeof input !== 'object' || input === null) return input
  const record: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const parsed = ConnectionConfigSchema.safeParse(record['config'])
  if (parsed.success) record['config'] = redactConnectionConfig(parsed.data)
  else delete record['config']
  return record
}
