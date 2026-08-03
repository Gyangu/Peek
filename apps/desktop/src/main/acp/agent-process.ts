/**
 * Lifecycle of the ACP agent child process.
 *
 * Modelled on `connections/host-process.ts` — spawn, crash detection, graceful
 * shutdown, forced kill, no zombies — but the mechanism is different and the
 * differences matter:
 *
 *  - the driver hosts are Electron `utilityProcess`es talking structured-clone
 *    `postMessage`; the ACP agent is a plain `child_process` speaking
 *    newline-delimited JSON-RPC over stdio, because that is the transport the
 *    protocol defines;
 *  - `utilityProcess.kill()` has no signal escalation. Here we have real signals,
 *    so shutdown walks stdin-close → SIGTERM → SIGKILL;
 *  - in Electron, `process.execPath` is the **Electron binary**, not Node. It
 *    only behaves as Node when `ELECTRON_RUN_AS_NODE=1` is in the child's
 *    environment, and forgetting it launches a second copy of the app.
 *
 * This class knows nothing about ACP semantics. It hands out the pair of streams
 * and reports that the process died; interpreting either is `connection.ts`'s
 * job.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { peekError, type PeekError } from '@peek/core'
import { redact, sanitizeLine } from './errors'
import type { AcpSpawnCommand } from './profiles'

/**
 * Agent stderr chatter that is normal and must not be shown as an error.
 *
 * The agent logs one of these per turn: it is an SDK message its own switch
 * statement does not cover. Surfacing it would train users to ignore the error
 * channel, which is the opposite of what an error channel is for.
 */
const STDERR_NOISE = ['Unexpected case: {"type":"system"'] as const

export interface AgentProcessHooks {
  /** The process is gone. `expected` means peek asked for it. */
  onExit(code: number | null, signal: NodeJS.Signals | null, expected: boolean): void
  /** One sanitised, redacted line of agent stderr. `noise` marks known-benign chatter. */
  onStderr(line: string, noise: boolean): void
}

export interface AgentSpawnOptions {
  /**
   * What to run. Comes from the agent's profile, because the two agents peek
   * ships with do not have the same process shape: `claude-agent-acp` is a Node
   * entry module that must be run by the Electron binary as Node, while
   * `codex-acp` ships its own executable.
   */
  command: AcpSpawnCommand
  /** Absolute, existing directory. The agent rejects anything else. */
  cwd: string
  /** Profile-supplied environment: the agent's sandbox switches live here. */
  env?: Record<string, string>
  /** Substituted into failure messages, e.g. "Claude Code". */
  displayName: string
  /** Redacted from every stderr line before it leaves this class. */
  secrets?: readonly string[]
}

export interface AgentStdio {
  toAgent: WritableStream<Uint8Array>
  fromAgent: ReadableStream<Uint8Array>
}

/* Locating an agent's entry module now belongs to its profile: see
 * `profiles.ts` and `resolvePackageEntry`. */

export class AgentProcess {
  #child: ChildProcessWithoutNullStreams | null = null
  #exited = false
  #expectedExit = false
  #stderrBuffer = ''
  #secrets: readonly string[] = []

  readonly #hooks: AgentProcessHooks

  constructor(hooks: AgentProcessHooks) {
    this.#hooks = hooks
  }

  get pid(): number | undefined {
    return this.#child?.pid
  }

  get alive(): boolean {
    return this.#child !== null && !this.#exited
  }

  /**
   * Start the agent and return its stdio as Web streams, which is the shape the
   * ACP SDK's `ndJsonStream` takes.
   *
   * Note what is *not* here: no readiness handshake. For ACP, `initialize` is the
   * handshake, and it belongs one layer up where the connection exists. A spawn
   * that fails structurally (bad path, EACCES) throws synchronously; a spawn that
   * succeeds and then dies immediately shows up as `onExit`, and the pending
   * `initialize` rejects on its own timeout.
   */
  start(opts: AgentSpawnOptions): AgentStdio {
    if (this.#child) throw peekError('CONFLICT', 'The agent process is already running.')
    this.#secrets = opts.secrets ?? []

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    // Without this, spawning process.execPath launches a second Electron app.
    // Only for agents that are Node entry modules; an agent shipping its own
    // executable must not get it, or it would run as Node instead of itself.
    if (opts.command.runAsNode) env['ELECTRON_RUN_AS_NODE'] = '1'
    // The profile's environment goes on last: its sandbox switches are the whole
    // reason it exists, and the inherited environment must not be able to
    // override them.
    for (const [key, value] of Object.entries(opts.env ?? {})) env[key] = value

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(opts.command.command, opts.command.args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (raw) {
      throw peekError('INTERNAL', `Could not start the ${opts.displayName} agent process.`, {
        detail: sanitizeLine(raw instanceof Error ? raw.message : String(raw)),
        retryable: true,
      })
    }

    this.#child = child
    this.#exited = false
    this.#expectedExit = false
    this.#wire(child)

    return {
      // Node streams → Web streams; the ACP SDK works in Web stream terms.
      toAgent: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      fromAgent: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    }
  }

  #wire(child: ChildProcessWithoutNullStreams): void {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.#onStderrChunk(chunk)
    })

    // spawn() can fail asynchronously (ENOENT surfaces here, not as a throw).
    child.on('error', (error: Error) => {
      this.#hooks.onStderr(sanitizeLine(redact(error.message, this.#secrets)), false)
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.#exited) return
      this.#exited = true
      const expected = this.#expectedExit
      this.#child = null
      this.#flushStderr()
      this.#hooks.onExit(code, signal, expected)
    })
  }

  /** Line-buffer stderr: a chunk boundary is not a line boundary. */
  #onStderrChunk(chunk: string): void {
    this.#stderrBuffer += chunk
    // Guard against an agent that never emits a newline.
    if (this.#stderrBuffer.length > 64_000) {
      this.#stderrBuffer = this.#stderrBuffer.slice(-16_000)
    }
    let index = this.#stderrBuffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#stderrBuffer.slice(0, index)
      this.#stderrBuffer = this.#stderrBuffer.slice(index + 1)
      this.#emitStderrLine(line)
      index = this.#stderrBuffer.indexOf('\n')
    }
  }

  #flushStderr(): void {
    const rest = this.#stderrBuffer
    this.#stderrBuffer = ''
    if (rest.trim()) this.#emitStderrLine(rest)
  }

  #emitStderrLine(raw: string): void {
    if (!raw.trim()) return
    const noise = STDERR_NOISE.some((needle) => raw.includes(needle))
    this.#hooks.onStderr(sanitizeLine(redact(raw, this.#secrets), 1_000), noise)
  }

  /**
   * Graceful shutdown: close stdin, then SIGTERM, then SIGKILL.
   *
   * Closing stdin first is the polite half — an ACP agent sees end-of-input and
   * winds down its own event loop. Every step swallows errors, because there is
   * only one goal here: the process must die and its resources must be reclaimed.
   */
  async shutdown(opts: { shutdownMs: number; exitMs: number }): Promise<void> {
    const child = this.#child
    if (!child || this.#exited) return
    this.#expectedExit = true

    try {
      child.stdin.end()
    } catch {
      /* Already closed; the signals below still apply. */
    }
    if (await this.waitExit(opts.shutdownMs)) return

    try {
      child.kill('SIGTERM')
    } catch {
      /* The process may have been reaped between the check and here. */
    }
    if (await this.waitExit(opts.exitMs)) return

    this.forceKill()
    await this.waitExit(opts.exitMs)
  }

  /** SIGKILL. The last resort, and the only guarantee. */
  forceKill(): void {
    const child = this.#child
    if (!child) return
    this.#expectedExit = true
    try {
      child.kill('SIGKILL')
    } catch {
      /* Nothing left to kill. */
    }
  }

  /** Resolves true when the process has exited, false on timeout. */
  waitExit(ms: number): Promise<boolean> {
    if (this.#exited || !this.#child) return Promise.resolve(true)
    const child = this.#child
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolve(false)
      }, ms)
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  }
}

/** The error surfaced when the agent dies with an in-flight request. */
export function agentGoneError(displayName: string): PeekError {
  return peekError('DRIVER_CRASHED', `The ${displayName} agent process exited.`, {
    detail: 'The chat panel restarts it automatically; the conversation so far is preserved.',
    retryable: true,
  })
}
