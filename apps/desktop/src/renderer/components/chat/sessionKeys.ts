/**
 * Where the arrow keys move the list's cursor; null for a key this list does
 * not claim.
 *
 * Deliberately **not** wrapping at the ends. A conversation list is scanned
 * top-down and its top is "most recent" — wrapping from the last row to the
 * first would silently teleport the user across a boundary that means something
 * here. `Home` / `End` are the fast way to either end, and they say so.
 */
export function sessionCursorKey(key: string, cursor: number, count: number): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(cursor + 1, count - 1)
    case 'ArrowUp':
      return Math.max(cursor - 1, 0)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
