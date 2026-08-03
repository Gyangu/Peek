/**
 * Put text on the clipboard, and say nothing when it does not work.
 *
 * There were seven `navigator.clipboard.writeText` calls in the renderer before
 * this. Three guarded the API with `?.` — it is undefined in a non-secure
 * context — and four did not, which is a `TypeError` in the console and a menu
 * item that appears to have done something. One place to fix that is worth the
 * three lines.
 *
 * **Silence on failure is the decision, not an omission.** A menu's copy is
 * verified by the user's next paste, immediately; a toast saying "copy failed"
 * would arrive after they already know. The grid deliberately does *not* use
 * this — `runCopy` has something a paste cannot tell you, namely how many rows
 * were left behind.
 */
export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    // Refused by the OS or unavailable. See above.
  })
}
