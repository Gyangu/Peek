import type { ChatMessage } from '@peek/core'
import { sanitizeLine } from './redact'

/** How much of a message `ChatViewState.lastMessagePreview` carries. */
export const PREVIEW_CHARS = 200

/**
 * The preview line for a transcript that is already complete.
 *
 * Both backends need it and neither owns it: the endpoint backend takes it after
 * a turn and when restoring from its thread store, the ACP backend when it draws
 * a stored snapshot. It is about *transcripts*, not about agents, which is why
 * it sits here rather than in either backend's directory — the same move, and
 * the same reason, as `buildReceipts` in `agent/context/resolve.ts`.
 *
 * The live streaming path does **not** come through here. It has the growing
 * text in hand and previews that instead of walking a transcript it would have
 * to rebuild; the two agree because both end at `sanitizeLine` with the same
 * budget.
 *
 * Searches backwards for the last message with text in it, so a turn that ended
 * on a tool call previews the last thing that was actually *said* rather than an
 * empty string. `''` when nothing in the conversation has text — a transcript of
 * pure tool calls has no preview, and inventing one from a tool name would put
 * something in the tab title that nobody wrote.
 */
export function lastMessagePreview(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message) continue
    for (let j = message.blocks.length - 1; j >= 0; j -= 1) {
      const block = message.blocks[j]
      if (block?.type === 'text' && block.text) return sanitizeLine(block.text, PREVIEW_CHARS)
    }
  }
  return ''
}
