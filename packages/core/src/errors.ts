import { z } from 'zod'

/**
 * 结构化错误。全链路（driver host → main → renderer → MCP）只允许传这一种错误形状，
 * 禁止把原始 Error 对象扔过 IPC（结构化克隆会丢 stack 之外的一切）。
 */
export const PEEK_ERROR_CODES = [
  /** 入参不合法（zod 校验失败、引用了不存在的 id 等） */
  'BAD_REQUEST',
  /** 目标不存在（connId / viewId / panelId / resultId 找不到） */
  'NOT_FOUND',
  /** 状态冲突（比如对未 ready 的连接跑查询） */
  'CONFLICT',
  /** 驱动不具备该 capability */
  'UNSUPPORTED_CAPABILITY',
  /** 建连失败 */
  'CONNECTION_FAILED',
  /** 连接中途断开 */
  'CONNECTION_LOST',
  /** 查询执行失败（DB 返回的错误） */
  'QUERY_FAILED',
  /** 语句语法错误（带 position 时可在编辑器里定位） */
  'SYNTAX_ERROR',
  /** 超时 */
  'TIMEOUT',
  /** 被主动取消 */
  'CANCELLED',
  /** driver host 进程崩溃/退出 */
  'DRIVER_CRASHED',
  /** 兜底 */
  'INTERNAL',
] as const

export const PeekErrorCodeSchema = z.enum(PEEK_ERROR_CODES)
export type PeekErrorCode = z.infer<typeof PeekErrorCodeSchema>

export const PeekErrorSchema = z.object({
  code: PeekErrorCodeSchema,
  /** 一句话人话，直接给用户看 */
  message: z.string(),
  /** 详情，可多行（驱动原文、SQL 片段等） */
  detail: z.string().optional(),
  /** 驱动原始错误码，如 PostgreSQL 的 SQLSTATE '42P01' */
  driverCode: z.string().optional(),
  /** 语法错误在语句里的字符偏移（1-based，跟 PG 的 position 语义一致） */
  position: z.number().int().nonnegative().optional(),
  /** 是否值得让用户重试 */
  retryable: z.boolean().optional(),
})

export type PeekError = z.infer<typeof PeekErrorSchema>

export type PeekErrorExtra = Omit<PeekError, 'code' | 'message'>

/** 构造结构化错误 */
export function peekError(code: PeekErrorCode, message: string, extra?: PeekErrorExtra): PeekError {
  return { code, message, ...extra }
}

export function isPeekError(value: unknown): value is PeekError {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['code'] === 'string' && typeof v['message'] === 'string'
    && (PEEK_ERROR_CODES as readonly string[]).includes(v['code'])
}

/**
 * 把任意 catch 到的东西收敛成 PeekError。
 * 驱动实现应尽量在自己那层给出更精确的 code / driverCode，不要全靠这个兜底。
 */
export function toPeekError(value: unknown, fallback: PeekErrorCode = 'INTERNAL'): PeekError {
  if (isPeekError(value)) return value
  if (value instanceof Error) {
    const extra: PeekErrorExtra = {}
    if (value.stack) extra.detail = value.stack
    // AbortError / DOMException 之类统一归到 CANCELLED
    const code = value.name === 'AbortError' ? 'CANCELLED' : fallback
    return { code, message: value.message || value.name, ...extra }
  }
  if (typeof value === 'string') return { code: fallback, message: value }
  return { code: fallback, message: 'Unknown error', detail: safeStringify(value) }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
