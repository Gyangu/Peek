import type { Draft } from 'immer'
import type { CommandInput, CommandName, CommandResultData, CommandSource, Workspace } from '@peek/core'
import type { IdFactory } from './ids'
import type { PlanEffect } from './intents'

/**
 * 命令 handler 的形状（PLAN 第 6 节：zod 校验 → handler → patch 广播 → 返回结果）。
 *
 * 一条命令最多分三段，全部可选：
 *   reduce   纯状态变更。跑在 immer draft 上，**不允许任何 I/O**，
 *            要做副作用就 `ctx.plan(intent)` 登记意图。
 *   （bus 在这里执行意图：真正去连库/跑查询，走注入的 CommandDeps）
 *   finalize 副作用跑完后，用最新的真源修正一下返回值（比如把 connecting 改成 ready）。
 *
 * 只读命令用 read 代替 reduce：不 bump rev、不广播 patch。
 */

export interface ReduceCtx {
  readonly source: CommandSource
  readonly commandId: string
  /** 本次命令的时间戳，handler 内一律用它而不是 Date.now()，保证可复现 */
  readonly now: number
  readonly ids: IdFactory
  readonly plan: PlanEffect
}

export type CommandReducer<K extends CommandName> = (
  draft: Draft<Workspace>,
  input: CommandInput<K>,
  ctx: ReduceCtx,
) => CommandResultData<K>

export type CommandReader<K extends CommandName> = (
  state: Workspace,
  input: CommandInput<K>,
  ctx: ReduceCtx,
) => CommandResultData<K>

export type CommandFinalizer<K extends CommandName> = (
  data: CommandResultData<K>,
  state: Workspace,
  ctx: ReduceCtx,
) => CommandResultData<K>

export interface CommandHandler<K extends CommandName> {
  reduce?: CommandReducer<K>
  read?: CommandReader<K>
  finalize?: CommandFinalizer<K>
}

/** 一批 handler 的声明形状，`satisfies CommandHandlerMap` 可保证键与入参类型对得上 */
export type CommandHandlerMap = { [K in CommandName]?: CommandHandler<K> }
