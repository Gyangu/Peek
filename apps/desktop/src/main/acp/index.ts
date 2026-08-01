/**
 * peek's ACP host: the chat panel's back end (PLAN sections 3 and 6).
 *
 * It owns one `@agentclientprotocol/claude-agent-acp` child process, one ACP
 * connection over its stdio, and one agent session per chat view. The agent
 * reaches back into peek through peek's own MCP server, so what the AI does to
 * the window travels the same Command Bus the human's clicks do — which is the
 * point of the whole feature.
 *
 * ## Wiring it up in `main/index.ts`
 *
 * ```ts
 * import { AcpManager, defaultAcpConfig } from './acp'
 *
 * const acp = new AcpManager({
 *   // Control plane: a Command, like every other state change.
 *   applyState: (patch) => commandBus.dispatch('chat.agentState', patch, 'agent').then(() => undefined),
 *   // Data plane: append-only transcript deltas, already batched.
 *   emitDeltas: (chatId, deltas) => sendChatDeltas(renderers(), chatId, deltas),
 *   notify,
 *   // Null while the MCP server is not listening — the manager warns instead of
 *   // silently creating a blind agent.
 *   resolveMcpEndpoint: () => mcpEndpoint,
 * }, defaultAcpConfig())
 *
 * app.on('before-quit', () => void acp.dispose())
 * ```
 *
 * Command handlers then call, and nothing else:
 *
 * | Command                   | Manager call                          |
 * | ------------------------- | ------------------------------------- |
 * | `chat.send`               | `acp.send({chatId, text, attachments})` |
 * | `chat.cancel`             | `acp.cancel(chatId)`                  |
 * | `chat.respondPermission`  | `acp.respondPermission(requestId, optionId)` |
 * | `chat.setMode`            | `acp.setPermissionMode(chatId, mode)` |
 * | `chat.clear`              | `acp.clear(chatId)`                   |
 * | `view.close` (kind chat)  | `acp.closeChat(chatId)`               |
 *
 * `chat.attach` / `chat.detach` never reach here: attachments are descriptors in
 * Workspace until send time, and resolving them needs the renderer's result
 * cache, so the caller materialises them and passes Markdown in.
 *
 * ## Two invariants this module will not give up
 *
 * **Nothing here holds a Command open across a turn.** `send()` returns once the
 * turn is accepted. The agent's tool calls come back into main over HTTP while
 * peek is awaiting the agent, and a Command that stayed in flight for the length
 * of a turn would put those two on the same thread of control.
 *
 * **The agent is untrusted.** Its stdout is data, never instruction; its stderr
 * is logged, never shown as an error; its text is sanitised before it reaches a
 * Workspace field; and the MCP bearer token is redacted from everything this
 * module emits. peek declares no filesystem and no terminal capability, so the
 * agent's only route back into the app is the MCP surface — which is to say, the
 * Command Bus, with the same validation everything else gets.
 */

export { AcpManager, defaultAcpConfig } from './manager'
export {
  DEFAULT_ACP_TIMEOUTS,
  DEFAULT_DELTA_BUDGET,
  DEFAULT_RESTART_POLICY,
  type AcpEventMap,
  type AcpHostConfig,
  type AcpHostDeps,
  type AcpPromptInput,
  type AcpResolvedAttachment,
  type AcpRestartPolicy,
  type AcpTimeouts,
  type ChatAgentStatePatch,
  type DeltaBatchBudget,
  type McpEndpointInfo,
} from './types'
export { AgentProcess, resolveAgentEntry, type AgentProcessHooks, type AgentSpawnOptions } from './agent-process'
export { DeltaBatcher, type BatcherTimers } from './batcher'
export { TranscriptTranslator, type ChatStateDelta, type TranslationOutput } from './translate'
export {
  PermissionBroker,
  toPermissionOptions,
  type PermissionCancelReason,
  type PermissionDecision,
  type PermissionRequestInput,
  type PermissionTicket,
} from './permissions'
export {
  CHAT_WORKDIR_NAME,
  PEEK_MCP_SERVER_NAME,
  buildPeekMcpServer,
  ensureChatWorkdir,
  type PeekMcpServerDescriptor,
} from './session-config'
export {
  AUTH_HELP,
  acpTimeout,
  classifyAcpError,
  isAuthFailure,
  isConnectionClosed,
  previewInput,
  redact,
  sanitizeLine,
} from './errors'
