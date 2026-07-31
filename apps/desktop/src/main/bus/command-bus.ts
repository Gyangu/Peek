import {
  commandErr,
  commandOk,
  isCommandName,
  newCommandId,
  parseCommandInput,
  peekError,
  type CommandEnvelope,
  type CommandInput,
  type CommandName,
  type CommandResultData,
  type CommandResultFor,
  type CommandSource,
} from '@peek/core'
import type { WorkspaceStore } from '../store/workspace-store'
import { CommandLog, redactCommandInput } from './command-log'
import type { CommandDeps } from './deps'
import { runIntents } from './effects'
import { asPeekError, fail } from './failure'
import { defaultIdFactory, type IdFactory } from './ids'
import type { EffectIntent } from './intents'
import type { CommandHandler, CommandHandlerMap, ReduceCtx } from './types'

/**
 * Command Bus —— 整个架构的心脏（PLAN 第 6 节）。
 *
 * **UI 事件和 MCP 工具调用走的是同一个 dispatch，没有任何分叉**：
 * source 只用于日志与审计，不改变任何一行执行路径。给 MCP 开后门 =
 * 人和 AI 的状态可能不一致 = 这个项目最核心的卖点没了。
 *
 * 一次 dispatch 的顺序：
 *   zod 校验 → reduce（纯状态，原子）→ patch 广播 → 副作用 → finalize → 结果 + 日志
 * 任何一步失败都收敛成 CommandResult 的 error 分支，**不向调用方抛异常**。
 */
export interface CommandBusOptions {
  store: WorkspaceStore
  deps: CommandDeps
  ids?: IdFactory
  log?: CommandLog
  /** 可注入的时钟，测试用 */
  now?: () => number
}

export class CommandBus {
  /**
   * 注册表是异构的：值的具体类型与键一一对应，这层关联由 register 的签名保证，
   * 存进来之后 TS 表达不了，所以统一存成 unknown，取出时按 name 收窄。
   */
  readonly #handlers = new Map<CommandName, unknown>()
  readonly #store: WorkspaceStore
  readonly #deps: CommandDeps
  readonly #ids: IdFactory
  readonly #now: () => number
  readonly log: CommandLog

  constructor(options: CommandBusOptions) {
    this.#store = options.store
    this.#deps = options.deps
    this.#ids = options.ids ?? defaultIdFactory
    this.#now = options.now ?? (() => Date.now())
    this.log = options.log ?? new CommandLog()
  }

  register<K extends CommandName>(name: K, handler: CommandHandler<K>): void {
    this.#handlers.set(name, handler)
  }

  registerAll(handlers: CommandHandlerMap): void {
    for (const name of Object.keys(handlers) as CommandName[]) {
      const handler = handlers[name]
      if (handler) this.#handlers.set(name, handler)
    }
  }

  has(name: CommandName): boolean {
    return this.#handlers.has(name)
  }

  get store(): WorkspaceStore {
    return this.#store
  }

  /** 执行一条命令。rawInput 未经校验，由这里统一过 zod。 */
  async dispatch<K extends CommandName>(
    name: K,
    rawInput: unknown,
    source: CommandSource,
    commandId?: string,
  ): Promise<CommandResultFor<K>> {
    const id = commandId ?? newCommandId()
    const startedAt = this.#now()

    const finish = (result: CommandResultFor<K>, loggedInput: unknown): CommandResultFor<K> => {
      this.log.push({
        commandId: id,
        ts: startedAt,
        source,
        name,
        input: redactCommandInput(name, loggedInput),
        ok: result.ok,
        rev: result.ok ? result.rev : this.#store.rev,
        elapsedMs: this.#now() - startedAt,
        ...(result.ok ? {} : { errorCode: result.error.code, errorMessage: result.error.message }),
      })
      return result
    }

    if (!isCommandName(name)) {
      return finish(commandErr(id, peekError('BAD_REQUEST', `未知命令 ${String(name)}`)), rawInput)
    }

    const parsed = parseCommandInput(name, rawInput)
    if (!parsed.ok) return finish(commandErr(id, parsed.error), rawInput)
    const input = parsed.input

    const handler = this.#handlers.get(name) as CommandHandler<K> | undefined
    if (!handler) {
      return finish(commandErr(id, peekError('INTERNAL', `命令 ${name} 没有注册 handler`)), input)
    }

    const intents: EffectIntent[] = []
    const ctx: ReduceCtx = {
      source,
      commandId: id,
      now: startedAt,
      ids: this.#ids,
      plan: (intent) => {
        intents.push(intent)
      },
    }

    try {
      let data = this.#runStateStage(handler, input, ctx, name, source, id)

      if (intents.length > 0) {
        await runIntents(intents, {
          store: this.#store,
          deps: this.#deps,
          commandId: id,
          commandName: name,
          source,
        })
      }

      if (handler.finalize) data = handler.finalize(data, this.#store.getState(), ctx)
      // rev 取副作用跑完后的最新值：conn.open 这类命令在副作用里还会再改状态
      return finish(commandOk(id, this.#store.rev, data), input)
    } catch (raw) {
      return finish(commandErr(id, asPeekError(raw)), input)
    }
  }

  /** 信封式入口，便于回放 Command 日志 */
  dispatchEnvelope<K extends CommandName>(envelope: CommandEnvelope<K>): Promise<CommandResultFor<K>> {
    return this.dispatch(envelope.name, envelope.input, envelope.source, envelope.id)
  }

  /**
   * 状态阶段：read（只读，不 bump rev）或 reduce（immer 原子变更 + patch 广播）。
   * reduce 抛异常时 immer 会丢弃整个 draft，状态不会留下半成品。
   */
  #runStateStage<K extends CommandName>(
    handler: CommandHandler<K>,
    input: CommandInput<K>,
    ctx: ReduceCtx,
    name: K,
    source: CommandSource,
    commandId: string,
  ): CommandResultData<K> {
    if (handler.read) return handler.read(this.#store.getState(), input, ctx)
    const reduce = handler.reduce
    if (!reduce) fail('INTERNAL', `命令 ${name} 既没有 reduce 也没有 read`)
    return this.#store.applyWith((draft) => reduce(draft, input, ctx), {
      commandId,
      commandName: name,
      source,
    }).value
  }
}
