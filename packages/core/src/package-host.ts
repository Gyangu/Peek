import type { CollectionRef, ConnectionConfig, DriverId } from './capability'
import type { Command } from './commands'
import { peekError, toPeekError, type PeekError } from './errors'
import { createLogger, formatLogLine } from './logger'
import type { DriverDisplay } from './manifest'
import type { CommandDispatch, CommandOutcome, ToolContext, ToolOutput, ToolSpec } from './mcp-tools'
import type {
  PackageViewAnswer,
  PackageViewKindName,
  PackageViewStateShape,
  ViewKindRegistration,
} from './view-kinds'
import type { WorkspaceSnapshot } from './workspace'

/* ==================================================================
 * The package host: the protocol one speaks, and the runtime that
 * speaks it from inside the process.
 *
 * ## Why a second host process type
 *
 * A package contributes four things that are not the driver — the three display
 * strings, a view kind's `autoFetch` / `title` / `describe` / `collectionRef`,
 * and its MCP tool handlers. All of it is pure computation, and all of it used
 * to run in main. It moved out because of what main can reach
 * (`docs/design/2026-08-07-database-packages-from-disk.md` §2.4bis b):
 * `safeStorage.decryptString` opens **every** saved credential, not only the
 * ones belonging to the package that asks. Since §2.10 ships no signature or
 * hash check, nothing stops a hostile package from being installed, and the
 * process boundary is then the only remaining thing it cannot argue its way
 * past — a static scan for `import 'node:fs'` loses to
 * `globalThis.process.mainModule.require('fs')`.
 *
 * ## Why it copies driver-host's shape but almost none of its size
 *
 * peek already has one main ↔ utilityProcess RPC, so this is the same envelope
 * (§2.4bis f-bis): `{kind:'req', rid, method, params}` out, `{kind:'res', rid,
 * ok, result|error}` back, rid pairing them, deadlines owned by main. The types
 * are separate from `ipc.ts`'s rather than shared because those carry the
 * driver's method table; the shape is the contract here, not the declaration.
 *
 * What is deliberately absent is everything a driver host needs in order to move
 * rows: no data plane, no MessagePort handed across, no chunks, no acks, no
 * backpressure, and no one-way events. A package host moves answers. Four
 * requests, four responses, and the process is idle again.
 *
 * That includes the `ready` event driver hosts announce themselves with. There
 * is nothing to announce: `parentPort` buffers messages until this file's
 * constructor starts listening, so the first response *is* the handshake, and a
 * host that never comes up is a request that times out — a case main already has
 * to handle anyway.
 *
 * ## Why `viewAnswer` answers three questions at once
 *
 * `title` and `describe` are read by `snapshotWorkspace`, which runs on every
 * patch broadcast and every MCP `read_workspace`. Asking for them one at a time
 * would turn one synchronous function into three round trips on a hot path. They
 * are computed with the fetch plan, once, before the reducer runs, and stored in
 * the view state so the snapshot only ever reads a string (§2.4bis e).
 *
 * ## Nothing here imports electron
 *
 * Same discipline as `driver-host.ts`, for the same reason: the transport is an
 * interface naming only the methods actually used, so the whole protocol runs in
 * `node:test` over an ordinary `MessageChannel`.
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* 0. What one MCP tool call looks like on this wire                    */
/* ------------------------------------------------------------------ */

/**
 * A step of a tool call, as main's executor asks for it.
 *
 * ## Why a phase, rather than "run the tool and give me the output"
 *
 * That was the first shape, and it cannot be built: it puts the executor in the
 * package's process. Everything a tool gets for free lives in
 * `defineCommandTool` — the second validation pass before a mapped input reaches
 * the Command Bus, the `uiEffects` block a tool can neither forget nor
 * misreport, and the catch that keeps one tool's exception from taking the MCP
 * server down. A host that returned a finished `ToolOutput` would be a second
 * execution path with none of them, and the divergence would surface as a
 * package tool quietly reporting a window it did not change.
 *
 * So the split follows the one `mcp-tools.ts` already states: **a package
 * declares the mapping; the app's executor is still the only thing that builds a
 * `PeekTool`.** The mapping is what crosses. A command tool crosses twice
 * because its two halves straddle the dispatch — `toCommands` runs before any
 * Command has been sent, `render` after all of them have landed, and the second
 * one reads a workspace the first one could not have seen (neo4j's `expand_node`
 * quotes the view's own `describe`, which only exists once the update applied).
 *
 * ## Why the snapshot travels
 *
 * A package's mapping needs `ToolContext`, and most of that context is live
 * main-process functions no structured clone can carry. The only part these
 * mappings actually read is `getSnapshot()`, which is plain redacted data. It is
 * sent rather than fetched back, which also makes the guarantee legible:
 * `dispatch` does not cross, so a package cannot reach the Command Bus with a
 * `CommandSource` of its choosing — the escalation §2.4bis(b) names outright.
 */
export type PackageToolCall =
  /** A command tool's `toCommands`, before anything is dispatched. */
  | { name: string; phase: 'commands'; args: unknown; snapshot: WorkspaceSnapshot }
  /** A command tool's own receipt renderer, after every Command has settled. */
  | {
      name: string
      phase: 'render'
      args: unknown
      snapshot: WorkspaceSnapshot
      outcomes: readonly CommandOutcome[]
    }
  /** A read tool's `read`, which never dispatches and so has only one step. */
  | { name: string; phase: 'read'; args: unknown; snapshot: WorkspaceSnapshot }

/**
 * The answer to one step.
 *
 * The `phase` is echoed so main can check that the answer it got is an answer to
 * the question it asked. That is not ceremony: this is the untrusted direction,
 * and a package returning `{phase:'read', output}` to a `commands` request would
 * otherwise reach `defineCommandTool` as an empty command list — a tool that
 * silently does nothing and reports success.
 */
export type PackageToolAnswer =
  | { phase: 'commands'; commands: readonly Command[] }
  /**
   * `null` means "this tool declares no renderer" — an answer, not a failure.
   * Main falls back to the default receipt, exactly as it does for a kernel tool
   * whose spec omits `render`.
   */
  | { phase: 'render'; output: ToolOutput | null }
  | { phase: 'read'; output: ToolOutput }

/* ------------------------------------------------------------------ */
/* 1. The four methods                                                  */
/* ------------------------------------------------------------------ */

export interface PackageHostRpcMap {
  /** Once per connection, when it is established. */
  display: {
    /**
     * The config has already been through `redactConnectionConfig` — the same
     * precondition `DriverDisplay` states, and one this boundary makes literal:
     * a package's own code is on the other side of it.
     */
    params: { driverId: DriverId; config: ConnectionConfig }
    result: { label: string; detail: string; endpoint: string }
  }

  /**
   * Everything the kernel needs to know about a package view, asked **before**
   * the `view.open` / `view.update` reducer runs. See the header for why the
   * three answers travel together.
   */
  viewAnswer: {
    params: { packageKind: PackageViewKindName; view: PackageViewStateShape }
    /**
     * Named rather than spelled out inline, unlike every other result here: two
     * thirds of it come to rest in `PackageViewState.packageText` and are read
     * from there for the life of the view, so the wire shape and the stored one
     * have to be the same shape — a field added to one and not the other would
     * be a value that crosses and then evaporates.
     */
    result: PackageViewAnswer
  }

  /** The collection a package view addresses, when core models it. */
  collectRef: {
    params: { packageKind: PackageViewKindName; view: PackageViewStateShape }
    result: CollectionRef | null
  }

  /**
   * One step of one MCP tool call — see `PackageToolCall` for why a step and not
   * a call.
   *
   * `args` is `unknown` on the wire, but it is not unvalidated: main parsed it
   * against the tool's own `inputSchema` before sending, which is the same
   * `parseInput` every kernel tool goes through. `ToolOutput.uiEffects` is
   * expected to come back absent — main fills that in by diffing the workspace,
   * so that a tool cannot forget it or misreport it, and a package is no
   * exception.
   */
  callTool: {
    params: PackageToolCall
    result: PackageToolAnswer
  }
}

export type PackageHostMethod = keyof PackageHostRpcMap
export type PackageHostParams<M extends PackageHostMethod> = PackageHostRpcMap[M]['params']
export type PackageHostResult<M extends PackageHostMethod> = PackageHostRpcMap[M]['result']

/* ------------------------------------------------------------------ */
/* 2. Envelope                                                          */
/* ------------------------------------------------------------------ */

/** main → package host */
export interface PackageHostRequestOf<M extends PackageHostMethod> {
  kind: 'req'
  /** Incremented within one process; pairs a response to its request */
  rid: number
  method: M
  params: PackageHostParams<M>
}
export type PackageHostRequest = {
  [M in PackageHostMethod]: PackageHostRequestOf<M>
}[PackageHostMethod]

/** package host → main */
export type PackageHostResponseOf<M extends PackageHostMethod> =
  | { kind: 'res'; rid: number; method: M; ok: true; result: PackageHostResult<M> }
  | { kind: 'res'; rid: number; method: M; ok: false; error: PeekError }
export type PackageHostResponse = {
  [M in PackageHostMethod]: PackageHostResponseOf<M>
}[PackageHostMethod]

/**
 * The two directions, named even though each has exactly one member today.
 *
 * They are what main's process wrapper imports, and naming them is what keeps
 * "a package host sends responses and nothing else" a statement the compiler
 * checks rather than a habit.
 */
export type PackageHostInbound = PackageHostRequest
export type PackageHostOutbound = PackageHostResponse

/* ------------------------------------------------------------------ */
/* 3. Transport abstraction: only the methods actually used             */
/* ------------------------------------------------------------------ */

export interface PackageHostChannelMessage {
  data: unknown
}

/** The channel to main (an Electron parentPort, or a node MessagePort in tests) */
export interface PackageHostChannel {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: PackageHostChannelMessage) => void): void
  start?(): void
}

/* ------------------------------------------------------------------ */
/* 4. Inbound message recognition                                       */
/* ------------------------------------------------------------------ */

/**
 * Keyed by method rather than written as a list, so that a method added to
 * `PackageHostRpcMap` and forgotten here is a compile error instead of a request
 * main sends into silence.
 */
const PACKAGE_HOST_METHOD_TABLE: Readonly<Record<PackageHostMethod, true>> = {
  display: true,
  viewAnswer: true,
  collectRef: true,
  callTool: true,
}

const PACKAGE_HOST_METHODS: ReadonlySet<string> = new Set(Object.keys(PACKAGE_HOST_METHOD_TABLE))

/**
 * Recognize an envelope; `params` is taken on trust.
 *
 * The same trade driver-host makes, for the same reason: main is the only sender
 * on this channel, and the side of this boundary that is not trusted is the
 * *other* one — the package's answers, which main validates on arrival.
 */
function isPackageHostRequest(data: unknown): data is PackageHostRequest {
  if (typeof data !== 'object' || data === null) return false
  if (!('kind' in data) || data.kind !== 'req') return false
  if (!('rid' in data) || typeof data.rid !== 'number') return false
  if (!('method' in data) || typeof data.method !== 'string') return false
  return PACKAGE_HOST_METHODS.has(data.method)
}

/* ------------------------------------------------------------------ */
/* 5. What a package contributed                                        */
/* ------------------------------------------------------------------ */

/**
 * A display plus the driver it is for.
 *
 * A pair rather than a record keyed by `DriverId`, because a package declares
 * displays for the drivers it ships and `Record<DriverId, …>` would demand all
 * six of them from each of them. A total record is a statement only something
 * holding every package at once could make, and since Phase C nothing does.
 */
export interface PackageDisplayEntry {
  driverId: DriverId
  display: DriverDisplay
}

export interface PackageHostRuntimeOptions {
  /** Displays this package contributes, looked up by `driverId`. */
  displays?: readonly PackageDisplayEntry[]
  /** View kinds this package contributes, looked up by `kind`. */
  viewKinds?: readonly ViewKindRegistration[]
  /**
   * Tool specs this package contributes, looked up by `name`.
   *
   * The whole spec, the same value `contrib.mjs` exports (design §2.4), even
   * though only the mapping runs here: `name` / `description` / `inputSchema`
   * are answered from the manifest in main without waking this process, which is
   * what lets `tools/list` cost nothing and keeps 20 installed packages off the
   * startup path (§2.4bis(d)). Splitting the value in two on the way in would
   * buy nothing and would make a package declare its tool twice.
   */
  tools?: readonly ToolSpec[]
}

/**
 * The `ToolContext` a package's mapping runs with.
 *
 * Deliberately a fraction of main's. `getSnapshot` returns the snapshot that
 * travelled with the request — the mapping's whole view of the world, and
 * already redacted. `logger` writes to stderr because a package host has no
 * event plane and main's process wrapper forwards stdio.
 *
 * `dispatch` throws, and that is the security property this file exists for
 * rather than an unimplemented stub: a thin-shell tool *returns* Commands for
 * main to dispatch, so no honest mapping calls this. A package that reaches for
 * it is asking to put a Command on the bus under whatever `CommandSource` it
 * likes, which is the escalation design §2.4bis(b) names as the reason package
 * code left main in the first place. `introspect` and `readResultRows` are
 * absent for the ordinary version of the same reason: they are live main-process
 * channels, and `ToolContext` already declares both optional.
 */
function packageToolContext(snapshot: WorkspaceSnapshot): ToolContext {
  const dispatch: CommandDispatch = () => {
    throw peekError(
      'BAD_REQUEST',
      'A package tool may not dispatch Commands. Return them from toCommands instead; '
        + 'main is what puts them on the bus.',
    )
  }
  return {
    dispatch,
    getSnapshot: () => snapshot,
    // Still stderr, because a package host has no event plane and no file of its
    // own — main's process wrapper forwards stdio, and that forwarding is what
    // gets these lines into `peek.log`. What changed is the *shape*: rendered by
    // `formatLogLine`, so a package's line is laid out like every other line in
    // that file instead of being the one that reads differently.
    logger: createLogger({
      ns: 'package',
      sink: (record) => {
        console.error(formatLogLine(record))
      },
      // No level control in here: the host is a child process with no access to
      // the user's setting, and dropping a line at the source is exactly the
      // mistake the renderer forwarding used to make. main filters what it keeps.
      minLevel: () => 'debug',
    }),
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }),
  }
}

/* ------------------------------------------------------------------ */
/* 6. The runtime                                                       */
/* ------------------------------------------------------------------ */

export class PackageHostRuntime {
  private readonly channel: PackageHostChannel
  private readonly displays: ReadonlyMap<DriverId, DriverDisplay>
  private readonly viewKinds: ReadonlyMap<PackageViewKindName, ViewKindRegistration>
  private readonly tools: ReadonlyMap<string, ToolSpec>

  constructor(channel: PackageHostChannel, options: PackageHostRuntimeOptions) {
    this.channel = channel
    const displays = new Map<DriverId, DriverDisplay>()
    for (const entry of options.displays ?? []) displays.set(entry.driverId, entry.display)
    this.displays = displays
    const viewKinds = new Map<PackageViewKindName, ViewKindRegistration>()
    for (const reg of options.viewKinds ?? []) viewKinds.set(reg.kind, reg)
    this.viewKinds = viewKinds
    const tools = new Map<string, ToolSpec>()
    for (const tool of options.tools ?? []) tools.set(tool.name, tool)
    this.tools = tools

    channel.on('message', (event) => {
      void this.onMessage(event)
    })
    channel.start?.()
  }

  private async onMessage(event: PackageHostChannelMessage): Promise<void> {
    const msg = event.data
    if (!isPackageHostRequest(msg)) return
    await this.handleRequest(msg)
  }

  /**
   * The rule this process exists to keep: **a package throwing is a response,
   * never an exit.**
   *
   * `postMessage` of the success reply is inside the `try` on purpose. A package
   * is free to hand back something structured clone cannot carry — a function on
   * the fetch plan, a Proxy in a tool's `data` — and the clone throws *here*, at
   * the send. Outside the `try` that would be a request main waits out to its
   * deadline with no idea why; inside it, it is an `ok: false` naming the reason.
   * The error reply itself is plain data, so it always clones.
   */
  private async handleRequest(req: PackageHostRequest): Promise<void> {
    try {
      const result = await this.dispatch(req)
      const res: PackageHostResponseOf<PackageHostMethod> = {
        kind: 'res',
        rid: req.rid,
        method: req.method,
        ok: true,
        result,
      }
      this.channel.postMessage(res)
    } catch (err) {
      const error: PeekError = toPeekError(err)
      const res: PackageHostResponseOf<PackageHostMethod> = {
        kind: 'res',
        rid: req.rid,
        method: req.method,
        ok: false,
        error,
      }
      this.channel.postMessage(res)
    }
  }

  private async dispatch(req: PackageHostRequest): Promise<PackageHostResult<PackageHostMethod>> {
    switch (req.method) {
      case 'display': {
        const display = this.displays.get(req.params.driverId)
        if (!display) {
          throw peekError(
            'NOT_FOUND',
            `This package contributes no display for driverId=${req.params.driverId}`,
          )
        }
        // Three calls, not three round trips — the same reason `viewAnswer`
        // bundles its answers, applied to a connection that has just opened.
        const config = req.params.config
        return {
          label: display.label(config),
          detail: display.detail(config),
          endpoint: display.endpoint(config),
        }
      }

      case 'viewAnswer': {
        const reg = this.requireViewKind(req.params.packageKind)
        const view = req.params.view
        return {
          fetch: reg.autoFetch(view),
          title: reg.title(view),
          describe: reg.describe(view),
        }
      }

      case 'collectRef': {
        const reg = this.requireViewKind(req.params.packageKind)
        return reg.collectionRef(req.params.view)
      }

      case 'callTool':
        return await this.callTool(req.params)
    }
  }

  /**
   * Run one step of a tool's mapping.
   *
   * The kind mismatches below are `BAD_REQUEST` rather than silence because the
   * only way to reach them is for main's view of a tool's declarative half to
   * disagree with the spec this process loaded — a stale manifest against a newer
   * `contrib.mjs`, say. Answering "that tool is not the shape you think it is" is
   * what turns that into a line a human can act on instead of a tool that returns
   * nothing.
   */
  private async callTool(call: PackageToolCall): Promise<PackageToolAnswer> {
    const spec = this.tools.get(call.name)
    if (!spec) {
      throw peekError('NOT_FOUND', `This package contributes no tool named ${call.name}`)
    }
    const ctx = packageToolContext(call.snapshot)

    switch (call.phase) {
      case 'commands': {
        if (spec.kind !== 'command') {
          throw peekError('BAD_REQUEST', `Tool ${call.name} is a read tool and maps onto no Commands`)
        }
        return { phase: 'commands', commands: await spec.toCommands(call.args, ctx) }
      }

      case 'render': {
        if (spec.kind !== 'command') {
          throw peekError('BAD_REQUEST', `Tool ${call.name} is a read tool and renders no command receipt`)
        }
        const render = spec.render
        if (render === undefined) return { phase: 'render', output: null }
        return { phase: 'render', output: await render([...call.outcomes], call.args, ctx) }
      }

      case 'read': {
        if (spec.kind !== 'read') {
          throw peekError('BAD_REQUEST', `Tool ${call.name} is a command tool; ask it for its Commands`)
        }
        return { phase: 'read', output: await spec.read(call.args, ctx) }
      }
    }
  }

  /**
   * `packageKind` is §0.1's name for what `PackageViewStateShape` still spells
   * `packageKind`; the two are the same string, and this file uses the new word
   * because the wire format is the part of the rename that has to land first.
   */
  private requireViewKind(packageKind: PackageViewKindName): ViewKindRegistration {
    const reg = this.viewKinds.get(packageKind)
    if (!reg) {
      throw peekError('NOT_FOUND', `This package contributes no view kind named ${packageKind}`)
    }
    return reg
  }
}

export function createPackageHostRuntime(
  channel: PackageHostChannel,
  options: PackageHostRuntimeOptions,
): PackageHostRuntime {
  return new PackageHostRuntime(channel, options)
}

/* ------------------------------------------------------------------ */
/* 7. Process entry                                                     */
/* ------------------------------------------------------------------ */

/**
 * Only what the fatal handlers below need. Reached structurally, like
 * `parentPort`, because core compiles with `types: []` and must not be able to
 * see node's runtime.
 */
interface HostProcessLike {
  on(event: string, listener: (arg: never) => void): void
}

function processGlobal(): unknown {
  const g: unknown = globalThis
  if (typeof g !== 'object' || g === null) return undefined
  return 'process' in g ? g.process : undefined
}

function isChannel(value: unknown): value is PackageHostChannel {
  if (typeof value !== 'object' || value === null) return false
  if (!('postMessage' in value) || typeof value.postMessage !== 'function') return false
  return 'on' in value && typeof value.on === 'function'
}

/**
 * Pull `parentPort` off `process` without reaching for `any`. Returns null
 * outside a utilityProcess — including in the renderer, which bundles core and
 * has no `process` at all.
 */
function getParentPort(): PackageHostChannel | null {
  const proc = processGlobal()
  if (typeof proc !== 'object' || proc === null) return null
  if (!('parentPort' in proc)) return null
  return isChannel(proc.parentPort) ? proc.parentPort : null
}

function getHostProcess(): HostProcessLike | null {
  const proc = processGlobal()
  if (typeof proc !== 'object' || proc === null) return null
  if (!('on' in proc) || typeof proc.on !== 'function') return null
  return { on: proc.on.bind(proc) }
}

export type StartPackageHostOptions = PackageHostRuntimeOptions

/**
 * Attach to `process.parentPort` and start answering.
 *
 * This is the whole body of a package host entry file: the entry imports the
 * package's `contrib.mjs` and hands over what it found. Everything
 * electron-specific stops at `parentPort` — a MessagePortMain that happens to
 * satisfy `PackageHostChannel` structurally.
 *
 * There is no `shutdown` method to match driver-host's. This process holds no
 * connection, no cursor and no file handle, so there is nothing for it to close
 * politely; uninstalling a package kills it, and that is the whole reason §2.4bis
 * (f) can say a removed package's code actually leaves memory.
 */
export function startPackageHostProcess(options: StartPackageHostOptions): PackageHostRuntime {
  const parentPort = getParentPort()
  const proc = getHostProcess()
  if (!parentPort || !proc) {
    throw new Error(
      'The package host must run inside an Electron utilityProcess (process.parentPort is missing)',
    )
  }

  const host = createPackageHostRuntime(parentPort, options)

  // The same rule as `handleRequest`, for the throws that arrive with no request
  // attached to them. Registering these is what turns node's default — print and
  // die — into "stay up and answer the next one"; a package whose stray timer
  // rejects must not take down the view that is still working. With no event
  // plane to report on, stderr is the channel, and main's process wrapper is
  // already forwarding it.
  proc.on('uncaughtException', (err: Error) => {
    console.error(`Uncaught exception in the package host: ${err.message}`, err.stack)
  })
  proc.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    console.error(`Unhandled promise rejection in the package host: ${msg}`)
  })

  return host
}
