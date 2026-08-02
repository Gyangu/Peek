import type { KeyValueResult, KeyValueShape, KeyValueWindow } from '@peek/core'

/* ==================================================================
 * Paging a key/value structure.
 *
 * `KeyValueResult.nextCursor` is one string field standing for three unrelated
 * things, and which one it is depends on the value's shape:
 *
 *   map, set      an opaque HSCAN / SSCAN cursor  → goes back as `cursorToken`
 *   list, sortedSet  the absolute index of the next element → goes back as `offset`
 *   stream        an exclusive entry id ('(1712…-0') → goes back as `cursorToken`
 *
 * Handing a hash cursor back as an offset silently skips or repeats fields, and
 * nothing in the wire type stops you: `KeyValueWindow` is a flat bag of optional
 * fields, because it crosses a process boundary where the compiler checks
 * nothing. This function is the inference, written once, so the inspector cannot
 * get it wrong in one branch and right in another.
 *
 * The window also carries the shape it was derived from. Without it the boundary
 * has to guess the addressing back — and guesses wrong for a stream, whose entry
 * id looks exactly like a hash cursor, so a stream's next page was validated as
 * a map's. Sending what we already know turns that guess into a check.
 * ================================================================== */

/** Which `KeyValueReadOptions` field addresses the next window of a shape. */
export function windowFieldFor(shape: KeyValueShape): 'cursorToken' | 'offset' | null {
  switch (shape) {
    case 'map':
    case 'set':
    case 'stream':
      return 'cursorToken'
    case 'list':
    case 'sortedSet':
      return 'offset'
    case 'scalar':
    case 'missing':
      // A scalar is not paged by elements — a large one is read through
      // valuePeek's byte range instead.
      return null
  }
}

/**
 * The request for the next window, or null when there is nothing further to
 * read (no cursor, an unpageable shape, or a cursor that does not parse as the
 * index its shape requires).
 */
export function nextKeyWindow(result: KeyValueResult, limit: number): KeyValueWindow | null {
  const cursor = result.nextCursor
  if (cursor === undefined || cursor === '') return null
  const shape = result.value.shape
  const field = windowFieldFor(shape)
  if (field === null) return null
  if (field === 'cursorToken') return { limit, shape, cursorToken: cursor }
  const offset = Number(cursor)
  if (!Number.isInteger(offset) || offset < 0) return null
  return { limit, shape, offset }
}

/** How many elements the current window actually holds — the "showing N of M" numerator. */
export function windowSize(result: KeyValueResult): number {
  const value = result.value
  switch (value.shape) {
    case 'scalar':
      return 1
    case 'map':
      return value.fields.length
    case 'list':
      return value.items.length
    case 'set':
      return value.members.length
    case 'sortedSet':
      return value.entries.length
    case 'stream':
      return value.entries.length
    case 'missing':
      return 0
  }
}
