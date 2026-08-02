import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  isTopModal,
  modalDepth,
  nextFocusIndex,
  popModal,
  pushModal,
  resetModalStack,
} from '../modalStack'

/* ==================================================================
 * Which dialog owns Escape, and where Tab goes at the edge of one.
 *
 * The bug behind the stack is worth restating, because it is invisible in any
 * single component: every modal registered its own `keydown` listener on
 * `window` and closed on Escape **without stopping the event** — and so did
 * `DataGrid`, whose Escape clears the row selection. One press with a value
 * modal open therefore closed the modal *and* discarded a row set the user had
 * built by hand, with the evidence hidden behind the dialog that was closing.
 * ================================================================== */

beforeEach(() => {
  resetModalStack()
})

describe('the modal stack', () => {
  test('the last one opened is the one that answers', () => {
    const outer = pushModal('settings')
    assert.equal(isTopModal(outer), true)

    const inner = pushModal('consent')
    assert.equal(isTopModal(inner), true)
    // The one underneath hears nothing — this is the whole point.
    assert.equal(isTopModal(outer), false)

    popModal(inner)
    assert.equal(isTopModal(outer), true)
  })

  test('an id that was never pushed is never on top', () => {
    pushModal('settings')
    assert.equal(isTopModal(Symbol('stranger')), false)
  })

  test('nothing is on top of an empty stack', () => {
    assert.equal(modalDepth(), 0)
    assert.equal(isTopModal(Symbol('anything')), false)
  })

  test('unmount order is not assumed', () => {
    // React can unmount an outer dialog before an inner one — a consent dialog
    // rendered by a context menu that is itself going away. Removing by
    // identity leaves the rest of the stack intact; popping blindly would
    // corrupt it.
    const a = pushModal('a')
    const b = pushModal('b')
    const c = pushModal('c')

    popModal(b)
    assert.equal(modalDepth(), 2)
    assert.equal(isTopModal(c), true)

    popModal(c)
    assert.equal(isTopModal(a), true)
  })

  test('popping the same id twice does not eat someone else’s entry', () => {
    const a = pushModal('a')
    const b = pushModal('b')
    popModal(a)
    popModal(a)
    assert.equal(modalDepth(), 1)
    assert.equal(isTopModal(b), true)
  })
})

describe('tab containment', () => {
  test('walks forward and wraps at the end', () => {
    assert.equal(nextFocusIndex(3, 0, false), 1)
    assert.equal(nextFocusIndex(3, 1, false), 2)
    assert.equal(nextFocusIndex(3, 2, false), 0)
  })

  test('walks backward and wraps at the start', () => {
    assert.equal(nextFocusIndex(3, 2, true), 1)
    assert.equal(nextFocusIndex(3, 0, true), 2)
  })

  test('focus that has escaped the dialog is pulled back to an end', () => {
    // `-1` is "the focused element is not in this dialog" — a programmatic focus
    // elsewhere, or the browser parking it on <body>. Tab must land back inside
    // rather than continuing through the window behind the mask.
    assert.equal(nextFocusIndex(3, -1, false), 0)
    assert.equal(nextFocusIndex(3, -1, true), 2)
  })

  test('a single control is its own next and previous', () => {
    assert.equal(nextFocusIndex(1, 0, false), 0)
    assert.equal(nextFocusIndex(1, 0, true), 0)
  })

  test('a dialog with nothing focusable still swallows the key', () => {
    // null means "focus nothing", not "let it through": a Tab that walks out of
    // a modal is the thing being prevented, and an empty dialog is not a reason
    // to allow it.
    assert.equal(nextFocusIndex(0, -1, false), null)
    assert.equal(nextFocusIndex(0, 0, true), null)
  })
})
