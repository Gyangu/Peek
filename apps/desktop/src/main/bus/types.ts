import type { Draft } from 'immer'
import type {
  CommandInput,
  CommandName,
  CommandResultData,
  CommandSource,
  PackageViewAnswer,
  Workspace,
} from '@peek/core'
import type { IdFactory } from './ids'
import type { PlanEffect } from './intents'

/**
 * The shape of a command handler (PLAN section 6: zod validation → handler →
 * patch broadcast → result).
 *
 * A command has at most four stages, all optional:
 *   prepare   Asynchronous prelude. Answers questions the reducer needs and
 *             cannot ask, because asking is I/O. Changes nothing.
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
  /**
   * What `prepare` came back with, for the commands that have one.
   *
   * Optional because most commands need nothing prepared, and absent-means-no-
   * answer is a case every consumer has to handle anyway: a `prepare` that could
   * not reach the package host resolves without the answer rather than failing
   * the command.
   */
  readonly prepared?: CommandPreparation
}

/**
 * The answers one command's asynchronous prelude worked out.
 *
 * A named record rather than an opaque per-handler payload: the bus carries it
 * from `prepare` to `reduce` and never reads it, but the things that go in here
 * are all of one kind — a value main used to compute inline and now has to ask
 * another process for — and naming them keeps that list visible in one place.
 */
export interface CommandPreparation {
  /**
   * What the package said about the package view this command opens or patches
   * (design 2026-08-07 §2.4bis e).
   *
   * One answer, because `view.open` and `view.update` each concern exactly one
   * view. Commands that can open several at once (`layout.setLayout`) do not
   * prepare, and their package views therefore open without a fetch until the
   * next `view.update` — see `startPackageFetch` in `handlers/shared.ts`.
   */
  packageView?: PackageViewAnswer
}

/**
 * The asynchronous prelude to a reduction.
 *
 * **This is the only place a Command may await before its state changes**, and
 * the whole reason it exists (design 2026-08-07 §2.4bis e): a package view's
 * fetch plan is computed by package code that now lives in another process,
 * while the reduction it feeds has to stay synchronous — every check-and-set in
 * the handlers is race-free because `produce` cannot be interrupted. So the
 * asynchrony moves *before* the reducer rather than into it.
 *
 * It gets the state and the input, and nothing that could change either. The
 * state it reads is one tick old by the time the reducer runs, which is why what
 * it returns is an *answer to a question about the input* rather than a decision
 * about the workspace: the reducer re-checks everything it acts on.
 *
 * **May return a plain value, and usually should.** A command declares one
 * `prepare` for a case that only some of its inputs hit — `view.update` prepares
 * for a package view and for nothing else — and an `async` function would hand
 * the bus a promise even then, spending a microtask before the reduction of
 * every table patch in the app. The bus awaits only what is actually a promise,
 * the same rule it already applies to the state stage.
 */
export type CommandPreparer<K extends CommandName> = (
  state: Workspace,
  input: CommandInput<K>,
) => CommandPreparation | Promise<CommandPreparation>


export type CommandReducer<K extends CommandName> = (
  draft: Draft<Workspace>,
  input: CommandInput<K>,
  ctx: ReduceCtx,
) => CommandResultData<K>

/**
 * The read-only state phase.
 *
 * **May be async, and `reduce` may not.** The asymmetry is the point: a reducer
 * runs inside a synchronous immer `produce`, and that synchrony is what makes
 * every check-and-set in the handlers race-free — an `await` in there would open
 * a window for another command to observe half-applied state. A reader changes
 * nothing, so it has no such window to protect, and some questions genuinely
 * cannot be answered without I/O (`chat.sessions.list` has to ask the agent).
 *
 * The bus awaits the result before the effect phase; a reader that returns a
 * plain value costs no extra tick.
 */
export type CommandReader<K extends CommandName> = (
  state: Workspace,
  input: CommandInput<K>,
  ctx: ReduceCtx,
) => CommandResultData<K> | Promise<CommandResultData<K>>

export type CommandFinalizer<K extends CommandName> = (
  data: CommandResultData<K>,
  state: Workspace,
  ctx: ReduceCtx,
) => CommandResultData<K>

export interface CommandHandler<K extends CommandName> {
  prepare?: CommandPreparer<K>
  reduce?: CommandReducer<K>
  read?: CommandReader<K>
  finalize?: CommandFinalizer<K>
}

/** Declaration shape for a batch of handlers; `satisfies CommandHandlerMap` proves keys and input types line up. */
export type CommandHandlerMap = { [K in CommandName]?: CommandHandler<K> }
