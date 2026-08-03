/**
 * The backend-agnostic half of the chat panel.
 *
 * Everything here holds regardless of where a token came from — a child process
 * speaking ACP (`agent/acp/`), or an LLM endpoint reached over HTTP
 * (`agent/endpoint/`). The dividing line is `ChatDelta` + `ChatAgentStatePatch`:
 * a backend's whole job is to produce those two, and everything downstream of
 * them — batching, the permission gate, attachment context, redaction — is
 * written once and shared.
 *
 * That line was already there before there was a second backend. `translate.ts`
 * had been turning ACP's `SessionUpdate` into exactly these types since the
 * chat panel was built, which is why this split is a move rather than a rewrite:
 * see `docs/design/2026-08-03-pluggable-agent-backends.md` §3.2 for the
 * file-by-file account of what moved and what stayed.
 */

export { DeltaBatcher, type BatcherTimers } from './batcher'
export {
  PermissionBroker,
  toPermissionOptions,
  type PermissionCancelReason,
  type PermissionDecision,
  type PermissionRequestInput,
  type PermissionTicket,
  type RawPermissionOption,
} from './permissions'
export { previewInput, redact, redactToolInput, sanitizeLine } from './redact'
export { DEFAULT_DELTA_BUDGET, type DeltaBatchBudget } from './types'
