import {
  commandErr,
  commandOk,
  isCommandName,
  newCommandId,
  parseCommandInput,
  peekErrorMsg,
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
import { asPeekError, failMsg } from './failure'
import { defaultIdFactory, type IdFactory } from './ids'
import type { EffectIntent } from './intents'
import type { CommandHandler, CommandHandlerMap, ReduceCtx } from './types'

/**
 * Command Bus — the heart of the architecture (PLAN section 6).
 *
 * **UI events and MCP tool calls go through the same dispatch, with no fork
 * anywhere**: `source` is recorded for logging and audit only, and never changes
 * a single line of the execution path. A back door for MCP would mean the human
 * and the AI could end up looking at different state — which is precisely the
 * property this project exists to guarantee.
 *
 * The order of one dispatch:
 *   zod validation → reduce (pure state, atomic) → patch broadcast → effects →
 *   finalize → result + log
 * A failure at any step collapses into the error branch of a CommandResult;
 * **no exception ever escapes to the caller**.
 */
export interface CommandBusOptions {
  store: WorkspaceStore
  deps: CommandDeps
  ids?: IdFactory
  log?: CommandLog
  /** Injectable clock, for tests */
  now?: () => number
}

export class CommandBus {
  /**
   * The registry is heterogeneous: each value's concrete type is tied to its key.
   * `register`'s signature enforces that correspondence at the call site, but TS
   * cannot express it for the stored map, so entries are kept as `unknown` and
   * narrowed by name on the way out.
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

  /** Run one command. `rawInput` is untrusted; zod validation happens here. */
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
      return finish(
        commandErr(id, peekErrorMsg('BAD_REQUEST', 'error.command.unknown', { name: String(name) })),
        rawInput,
      )
    }

    const parsed = parseCommandInput(name, rawInput)
    if (!parsed.ok) return finish(commandErr(id, parsed.error), rawInput)
    const input = parsed.input

    const handler = this.#handlers.get(name) as CommandHandler<K> | undefined
    if (!handler) {
      return finish(commandErr(id, peekErrorMsg('INTERNAL', 'error.command.noHandler', { name })), input)
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
      // Awaited only when it actually is a promise: a reducer's result must reach
      // the effect phase in the same tick it was produced, and `await` on a plain
      // value would insert a microtask between them for every command in the app.
      const staged = this.#runStateStage(handler, input, ctx, name, source, id)
      let data = staged instanceof Promise ? await staged : staged

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
      // Report the rev from *after* the effects ran: commands like conn.open keep
      // mutating state during their effect phase.
      return finish(commandOk(id, this.#store.rev, data), input)
    } catch (raw) {
      return finish(commandErr(id, asPeekError(raw)), input)
    }
  }

  /** Envelope entry point, so a Command log can be replayed verbatim. */
  dispatchEnvelope<K extends CommandName>(envelope: CommandEnvelope<K>): Promise<CommandResultFor<K>> {
    return this.dispatch(envelope.name, envelope.input, envelope.source, envelope.id)
  }

  /**
   * The state phase: either `read` (read-only, does not bump rev) or `reduce`
   * (atomic immer mutation + patch broadcast). When `reduce` throws, immer
   * discards the whole draft, so no half-applied state survives.
   */
  #runStateStage<K extends CommandName>(
    handler: CommandHandler<K>,
    input: CommandInput<K>,
    ctx: ReduceCtx,
    name: K,
    source: CommandSource,
    commandId: string,
  ): CommandResultData<K> | Promise<CommandResultData<K>> {
    if (handler.read) return handler.read(this.#store.getState(), input, ctx)
    const reduce = handler.reduce
    if (!reduce) failMsg('INTERNAL', 'error.command.notReducible', { name })
    return this.#store.applyWith((draft) => reduce(draft, input, ctx), {
      commandId,
      commandName: name,
      source,
    }).value
  }
}
