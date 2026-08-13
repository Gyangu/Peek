/**
 * The ACP host's dependency interface and configuration.
 *
 * The same discipline `bus/deps.ts` uses applies here, for the same reason: this
 * module knows **only these interfaces** and never imports the Command Bus, the
 * WorkspaceStore or the MCP server. `main/index.ts` injects the real
 * implementations during assembly. That is what lets the ACP host be unit-tested
 * without Electron, without a live agent and without a database, and what keeps
 * the dependency graph pointing one way.
 */

import type {
  AttachmentId,
  AttachmentTruncation,
  ChatAgentStatus,
  ChatAttachment,
  ChatDelta,
  ChatId,
  ChatMessageId,
  ChatPermissionMode,
  ChatUsage,
  NotifyMessage,
  PeekError,
  PendingPermission,
} from '@peek/core'
import type { DeltaBatchBudget } from '../agent/types'
import type { AcpAgentProfile, AcpAgentUserConfig } from './profiles'
import type { SessionIndex } from '../agent/session-index'
import type { AcpSnapshotStore } from './snapshot-store'

/** Re-exported: the batching budget is backend-agnostic and lives in `agent/types.ts`. */
export { DEFAULT_DELTA_BUDGET, type DeltaBatchBudget } from '../agent/types'

/* ================================================================== */
/* 1. The two channels out of the ACP host                             */
/* ================================================================== */

/**
 * Every Workspace-visible field of a `ChatViewState` the agent is allowed to
 * move, gathered into one patch.
 *
 * **Why one patch and not one command per field.** Every field here is
 * control-plane: small, low-frequency (a handful per turn), and something both
 * the human looking at the window and the AI calling `read_workspace` must see.
 * Bundling them means a turn's whole state transition — "streaming stopped, this
 * message id is no longer live, usage went up, the permission cleared" — commits
 * as one revision instead of four, so no observer can catch the view in a state
 * that never really existed.
 *
 * `undefined` means "leave alone"; `null` on a nullable field means "clear it".
 */
export interface ChatAgentStatePatch {
  chatId: ChatId
  status?: ChatAgentStatus
  agentSessionId?: string | null
  permissionMode?: ChatPermissionMode
  streamingMessageId?: ChatMessageId | null
  messageCount?: number
  lastMessagePreview?: string
  usage?: ChatUsage
  pendingPermission?: PendingPermission | null
  /** See `ChatViewState.showingSnapshot`. Set when a picture goes up, cleared when the agent's copy replaces it. */
  showingSnapshot?: boolean
}

/**
 * What the ACP host needs from the rest of main.
 *
 * ## The split, and why it does not break the architecture
 *
 * `applyState` is a **Command**. Everything it carries lives in the Workspace
 * source of truth, so it goes through the Command Bus like every other state
 * change — no back door, the AI and the human read the same store.
 *
 * `emitDeltas` is **not** a Command, and deliberately so. `packages/core/src/chat.ts`
 * settles this: the transcript is data plane, and data plane does not go through
 * immer diffing and patch broadcast (PLAN section 3, and the precedent
 * `ResultMeta` already set). Text arrives token by token; routing each token
 * through reduce → diff → broadcast would bump `rev` hundreds of times per turn,
 * make every unrelated command slower as the conversation grows, and stuff the
 * whole conversation into every `read_workspace` reply.
 *
 * The renderer still invents nothing. It projects an append-only delta stream
 * that main authored, exactly as it projects the patch stream that main authored.
 * What differs is the transport for one payload, not who decides.
 *
 * Both methods must be **non-throwing and non-blocking**: they are called from
 * inside an ACP notification handler, and main's event loop is on the critical
 * path of the agent's own MCP calls back into peek (agent → HTTP → main →
 * Command Bus). Blocking here deadlocks the loop that makes this feature
 * worthwhile.
 */
export interface AcpHostDeps {
  /**
   * Commit a control-plane patch. Maps to a `chat.agentState` command dispatched
   * with source `'agent'`.
   *
   * Implementations must swallow their own failures — a rejected promise here is
   * logged and dropped, never propagated into the ACP handler.
   */
  applyState(patch: ChatAgentStatePatch): Promise<void>
  /** Ship one already-batched, already-coalesced run of transcript deltas. */
  emitDeltas(chatId: ChatId, deltas: readonly ChatDelta[]): void
  /** Toasts and the main-process log. */
  notify(message: NotifyMessage): void
  /**
   * peek's own MCP endpoint, resolved at session-creation time.
   *
   * Returning `null` means the endpoint is **not listening** — and the ACP host
   * then creates the session without it and warns loudly. That check exists
   * because `session/new` silently degrades when an MCP server is unreachable:
   * without it the user gets a Claude that cannot see the window, and no error
   * anywhere explaining why.
   */
  resolveMcpEndpoint(): McpEndpointInfo | null
  /**
   * Where to record which backend owns a conversation.
   *
   * Optional because the index is a routing convenience, not a source of truth:
   * every conversation's history still lives with the backend that wrote it, and
   * a host running without an index simply cannot label rows. Tests leave it out.
   */
  sessionIndex?: SessionIndex
  /**
   * Where to keep a picture of what the window drew, so the next open can show
   * it while `session/load` builds the live session behind it.
   *
   * Optional for the same reason as `sessionIndex`, and with a stronger one on
   * top: a host without it is not degraded in any way a user could name — every
   * conversation still opens, from the agent, exactly as before. The snapshot
   * only removes a wait. See `AcpSnapshotStore` for why storing this does not
   * contradict "peek keeps no ACP transcripts".
   */
  snapshots?: AcpSnapshotStore
}

/** Where peek's MCP server is listening, and the bearer token that opens it. */
export interface McpEndpointInfo {
  url: string
  token: string
}

/* ================================================================== */
/* 2. Configuration                                                    */
/* ================================================================== */

export interface AcpTimeouts {
  /** `initialize` doubles as the ready handshake: no answer means no usable agent. */
  initializeMs: number
  newSessionMs: number
  /**
   * `session/load`. Longer than `newSessionMs` on purpose: the request does not
   * return until the agent has replayed the whole transcript, so what it bounds
   * grows with the length of the conversation being opened rather than with the
   * cost of a handshake.
   */
  loadSessionMs: number
  /** `session/list`; a directory read on the agent's side, so a short budget. */
  listSessionsMs: number
  /** `session/delete`; likewise a file operation, not model work. */
  deleteSessionMs: number
  /** `session/set_mode`; a failure here is not fatal but must not hang. */
  setModeMs: number
  /**
   * How long a turn may go with **no session update at all** before peek treats
   * it as stalled and cancels.
   *
   * An idle budget, not a wall-clock one, on purpose. A legitimate turn with a
   * dozen tool calls easily runs past any fixed ceiling, while a wedged one is
   * recognisable by silence — the observed failure mode is the agent retrying an
   * unreachable API for ~175 seconds with nothing on the wire. Cancelling on
   * silence catches that without ever cutting off work that is visibly
   * progressing.
   */
  promptIdleMs: number
  /**
   * Absolute ceiling on one turn, measured in **agent time**. `0` disables it.
   *
   * ## Why an absolute ceiling exists at all, given the idle watchdog
   *
   * `promptIdleMs` catches silence, and silence is the observed failure mode.
   * It cannot catch the other one: a turn that keeps *talking*. Every token, every
   * `tool_call_update`, resets the idle clock, so an agent stuck in a loop —
   * re-reading the same view, re-planning, apologising and retrying — is
   * indistinguishable from one making progress, and with `promptMaxMs` at `0`
   * (which it used to be) that turn had no end at all. It burns tokens for as
   * long as the window is open, and it holds the chat's `streaming` flag, so the
   * user's only exit is the stop button.
   *
   * ## Why 30 minutes, and why it is not wall-clock
   *
   * The number has to clear the longest turn a person would still call working.
   * The slowest legitimate turns measured here — a dozen `mcp__peek__*` calls,
   * each opening a view and streaming a summary — run in single-digit minutes,
   * so 30 leaves an order of magnitude of headroom and still bounds a runaway
   * turn to something a user notices once rather than something that runs until
   * they quit the app.
   *
   * **Time a human spends deciding does not count**, and that is not a detail.
   * `permissionMs` is 5 minutes; a turn asking for six approvals could otherwise
   * spend its whole budget on dialogs and be killed with the agent having done
   * nothing wrong — the same contradiction the idle watchdog already had to fix
   * once. The timer is therefore paused while any permission prompt is
   * outstanding, so what this bounds is the agent's own work.
   */
  promptMaxMs: number
  /**
   * How long a permission prompt may sit unanswered before peek answers
   * `cancelled` on the user's behalf.
   *
   * Never `allow`: an absent user is not a consenting user. `cancelled` is the
   * protocol's own "no decision was made" outcome, and it grants nothing and
   * records nothing.
   */
  permissionMs: number
  /** Grace between closing stdin and SIGTERM. */
  shutdownMs: number
  /** Grace between SIGTERM and SIGKILL. */
  exitMs: number
}

export const DEFAULT_ACP_TIMEOUTS: AcpTimeouts = {
  initializeMs: 30_000,
  newSessionMs: 60_000,
  loadSessionMs: 120_000,
  listSessionsMs: 15_000,
  deleteSessionMs: 15_000,
  setModeMs: 10_000,
  promptIdleMs: 90_000,
  promptMaxMs: 1_800_000,
  permissionMs: 300_000,
  shutdownMs: 3_000,
  exitMs: 3_000,
}


export interface AcpRestartPolicy {
  /** Restart attempts allowed inside `windowMs`. */
  maxAttempts: number
  windowMs: number
  /** Backoff before attempt *n*; the last entry repeats. */
  backoffMs: readonly number[]
}

export const DEFAULT_RESTART_POLICY: AcpRestartPolicy = {
  maxAttempts: 3,
  windowMs: 60_000,
  backoffMs: [500, 2_000, 5_000],
}

export interface AcpHostConfig {
  /**
   * Resolve the agent session's working directory. Must return an existing
   * absolute path; the agent rejects anything else.
   *
   * peek uses a directory of its own (`~/.peek/chat`) rather than the user's
   * project or home directory. `cwd` is what the agent resolves its
   * project-level configuration against, and it is the root its own file tools
   * would work from. Pointing it at a real project would import that project's
   * configuration into a database viewer's chat panel; pointing it at `~` would
   * hand the agent the whole home directory.
   *
   * **A function, not a string, on purpose.** Creating the directory can fail —
   * a read-only home, hostile permissions, a plain file already sitting at the
   * path — and resolving it during assembly made that failure take the whole app
   * down before a window existed. Deferring it to the moment an agent is
   * actually started costs one conversation instead.
   */
  resolveCwd: () => string
  /**
   * Which agent to run. Carries its process shape, its sandbox switches and its
   * display name; see `profiles.ts`.
   */
  profile: AcpAgentProfile
  /** Per-agent user settings, handed to every profile hook. */
  agentConfig: AcpAgentUserConfig
  /**
   * Bypasses the profile's own `resolveSpawn`.
   *
   * Exists for the tests, which run a stub agent out of `__tests__/`. A profile
   * resolves a published package; a test needs to point at a file in the repo,
   * and threading that through a fake profile would mean the tests exercise a
   * different code path than production does.
   */
  agentEntryPath?: string
  /**
   * The mode requested right after `session/new` — the one a new conversation
   * starts in.
   *
   * **A function, not a value, on purpose**, and for a different reason than
   * `resolveCwd` above: this one can *change* while the app runs. It was a value
   * read from `settings.json` once during assembly, so the setting the panel
   * calls "what new conversations start in" only reached conversations started
   * after the next launch — while the copy beside it made a restart promise on
   * behalf of the backend picker, which really does need one, and said nothing
   * about this.
   *
   * A thunk rather than a setter somebody calls after a write: a setter has to
   * be *called*, and "who forgot to push" names the whole family of bug this is
   * one of. Read at the moment it is used and there is no window to be stale in.
   *
   * See `design/2026-08-13-permission-mode-takes-effect.md`.
   */
  permissionMode: () => ChatPermissionMode
  /**
   * Reported to the agent as `clientInfo.version`.
   *
   * Passed in rather than read from Electron's `app`, so the manager carries no
   * Electron import and can be exercised outside a running app. Assembly passes
   * `app.getVersion()`.
   */
  clientVersion?: string
  timeouts: AcpTimeouts
  batch: DeltaBatchBudget
  restart: AcpRestartPolicy
  /** Forward the agent's stderr to the main-process log. Noisy; off by default. */
  verbose: boolean
}

/* ================================================================== */
/* 3. Events the host emits (diagnostics, not state)                   */
/* ================================================================== */

export interface AcpEventMap extends Record<string, unknown> {
  /** The agent process reached a usable state (`initialize` returned). */
  ready: { pid: number | undefined; agentName: string; agentVersion: string }
  /** The process is gone. `expected` distinguishes shutdown from a crash. */
  exit: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }
  /** A restart is being attempted. */
  restarting: { attempt: number; delayMs: number }
  /** Restarts are exhausted; the panel is dead until the user retries. */
  gaveUp: { error: PeekError }
  /** Diagnostic log line, already redacted. */
  log: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; detail?: string }
}

/* ================================================================== */
/* 4. Prompt input                                                     */
/* ================================================================== */

/**
 * One user turn: the typed text plus already-materialised attachments.
 *
 * Attachments arrive here as resolved Markdown, not as descriptors. Resolving a
 * `ChatAttachment` needs the renderer's result cache, which the ACP host has no
 * route to; the caller does that and hands the outcome over. Keeping the
 * resolution outside also means a descriptor that fails to resolve produces a
 * visible error on the command that staged it, rather than a silent gap in a
 * prompt that has already been sent.
 */
export interface AcpPromptInput {
  chatId: ChatId
  text: string
  /** Materialised Markdown, sent to the agent. */
  attachments: readonly AcpResolvedAttachment[]
  /**
   * The descriptors those payloads came from, kept on the transcript message so
   * the UI can re-display "this turn carried these three things" without
   * storing the payloads a second time.
   */
  descriptors?: readonly ChatAttachment[]
}

export interface AcpResolvedAttachment {
  /** Which descriptor this came from, so a receipt can be matched back to a chip. */
  attachmentId: AttachmentId
  /** Stable and unique per attachment, e.g. `peek://result/res_ab12/rows`. */
  uri: string
  mimeType: 'text/markdown'
  text: string
  /**
   * What was left out, when anything was.
   *
   * Carried even though the agent never reads it: the model is told inside the
   * document body, and this is the same fact travelling to the *other* audience.
   * Dropping it here — which this interface used to do — meant the "first 100 of
   * 12,345 rows" `budget.ts` promises the user was only ever shown to the model.
   */
  notice?: AttachmentTruncation | null
  /** The descriptor could not be resolved; the payload says so and carries no data. */
  error?: PeekError
}
