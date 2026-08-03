/**
 * Types shared by every agent backend.
 *
 * What lives here is what the UI-facing half of the chat panel needs regardless
 * of where the tokens came from: a child process speaking ACP, or an LLM
 * endpoint reached over HTTP. Backend-specific configuration stays with its
 * backend (`agent/acp/types.ts`, `agent/endpoint/types.ts`).
 */

/**
 * The coalescing budget for transcript deltas.
 *
 * ## The tension, stated plainly
 *
 * One IPC message per token is unusable; one IPC message per turn is not
 * streaming. The budget below picks the largest window a reader cannot feel.
 *
 * `intervalMs: 50` is twenty flushes a second. Perceptual work on interface
 * latency puts the threshold for "instant" at roughly 100 ms, so a 50 ms ceiling
 * on added lag sits comfortably under it while cutting IPC traffic by one to two
 * orders of magnitude — a fast turn emits tokens far quicker than 20 Hz, so a
 * flush typically carries a whole phrase rather than a character. Reading speed
 * is nowhere near 20 phrases per second either way.
 *
 * `maxChars` and `maxDeltas` bound a single flush so a burst (a large tool
 * result, a paste-sized completion) cannot build one enormous IPC payload.
 *
 * **Structural deltas do not wait.** `message.start`, `message.end` and every
 * `tool.upsert` flush immediately, because they are what the UI binds
 * affordances to: the stop button appearing, a spinner resolving, a tool row
 * turning green. Fifty milliseconds of lag on prose is invisible; on a control
 * that the user is about to click it is a bug. Text and thought chunks are the
 * only things that ever sit in the buffer, and consecutive ones for the same
 * message are concatenated into a single delta before they leave.
 */
export interface DeltaBatchBudget {
  intervalMs: number
  maxChars: number
  maxDeltas: number
}

export const DEFAULT_DELTA_BUDGET: DeltaBatchBudget = {
  intervalMs: 50,
  maxChars: 8_192,
  maxDeltas: 64,
}
