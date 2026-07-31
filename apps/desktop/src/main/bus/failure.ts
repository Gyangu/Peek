import { peekError, toPeekError, type PeekError, type PeekErrorCode } from '@peek/core'

/**
 * 命令失败信号。
 *
 * handler 的纯状态阶段直接 `throw fail(...)`：immer 的 draft 会被整个丢弃，
 * 状态不留半成品；Command Bus 在最外层把它收敛成 CommandResult 的 error 分支，
 * **异常绝不会漏到调用方**（UI 的 invoke 和 MCP 工具都只会拿到结构化结果）。
 */
export class CommandFailure extends Error {
  readonly error: PeekError

  constructor(error: PeekError) {
    super(error.message)
    this.name = 'CommandFailure'
    this.error = error
  }
}

export type PeekErrorExtra = Omit<PeekError, 'code' | 'message'>

/** 构造并抛出一个命令失败 */
export function fail(code: PeekErrorCode, message: string, extra?: PeekErrorExtra): never {
  throw new CommandFailure(peekError(code, message, extra))
}

/** 把任意 catch 到的东西收敛成 PeekError */
export function asPeekError(value: unknown, fallback: PeekErrorCode = 'INTERNAL'): PeekError {
  if (value instanceof CommandFailure) return value.error
  return toPeekError(value, fallback)
}
