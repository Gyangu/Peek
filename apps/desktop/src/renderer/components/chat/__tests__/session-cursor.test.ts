import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessionCursorKey } from '../sessionKeys'

/**
 * The conversation list's keyboard cursor.
 *
 * The list is a `listbox` — one tab stop, arrows inside — so this function is
 * the whole of "where does the next arrow go". It is pure and the rail is not,
 * which is exactly why it was pulled out: the interesting rule (the ends do not
 * wrap) is testable without a DOM.
 */

test('the arrows move one row and stop at the ends', () => {
  assert.equal(sessionCursorKey('ArrowDown', 0, 3), 1)
  assert.equal(sessionCursorKey('ArrowUp', 1, 3), 0)
  assert.equal(sessionCursorKey('ArrowDown', 2, 3), 2, 'the last row does not wrap to the first')
  assert.equal(sessionCursorKey('ArrowUp', 0, 3), 0, 'nor the first to the last')
})

test('Home and End are the fast way to either end', () => {
  assert.equal(sessionCursorKey('Home', 2, 3), 0)
  assert.equal(sessionCursorKey('End', 0, 3), 2)
})

test('keys this list does not claim are left alone, and an empty list claims none', () => {
  assert.equal(sessionCursorKey('Enter', 0, 3), null, 'opening is the row’s key, not the list’s')
  assert.equal(sessionCursorKey('a', 0, 3), null)
  assert.equal(sessionCursorKey('ArrowDown', 0, 0), null)
})
