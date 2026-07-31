import type { Draft } from 'immer'
import type { CommandInput, CommandName, CommandResultData, CommandSource, Workspace } from '@peek/core'
import type { IdFactory } from './ids'
import type { PlanEffect } from './intents'

/**
 * The shape of a command handler (PLAN section 6: zod validation → handler →
 * patch broadcast → result).
 *
 * A command has at most three stages, all optional:
 *   reduce    Pure state change. Runs on an immer draft and **must not do any
 *             I/O** — register side effects with `ctx.plan(intent)` instead.
 *   (the bus runs those intents here: actually connecting, actually querying,
 *    through the injected CommandDeps)
 *   finalize  After the effects have run, correct the return value against the
 *             fresh source of truth (e.g. turn `connecting` into `ready`).
 *
 * Read-only commands use `read` in place of `reduce`: no rev bump, no patches.
 */

export interface ReduceCtx {
  readonly source: CommandSource
  readonly commandId: string
  /** Timestamp of this command. Handlers use it instead of Date.now() so runs are reproducible. */
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

/** Declaration shape for a batch of handlers; `satisfies CommandHandlerMap` proves keys and input types line up. */
export type CommandHandlerMap = { [K in CommandName]?: CommandHandler<K> }
