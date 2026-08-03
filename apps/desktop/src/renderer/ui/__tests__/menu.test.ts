import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MENU_EDGE_GAP,
  confirmNodes,
  nextItemIndex,
  placeMenu,
  selectableItems,
  type MenuItemNode,
  type MenuNode,
} from '../menuModel'

/* ==================================================================
 * The popup menu's decisions, without a DOM.
 *
 * Design record: docs/design/2026-08-03-context-menu-primitive.md §4
 * ================================================================== */

function item(id: string, extra: Partial<MenuItemNode> = {}): MenuItemNode {
  return { kind: 'item', id, label: id, onSelect: () => {}, ...extra }
}

describe('what the arrow keys can reach', () => {
  test('separators, headings and notes are not stops', () => {
    const nodes: MenuNode[] = [
      { kind: 'head', id: 'h', text: 'Group' },
      item('a'),
      { kind: 'sep', id: 's' },
      { kind: 'note', id: 'n', text: 'no chat panel' },
      item('b'),
    ]
    assert.deepEqual(
      selectableItems(nodes).map((n) => n.id),
      ['a', 'b'],
    )
  })

  test('a disabled item is skipped', () => {
    // Not merely dimmed: an item that cannot act must not be able to take the
    // focus either, or the keyboard lands somewhere Enter does nothing.
    assert.deepEqual(
      selectableItems([item('a', { disabled: true }), item('b')]).map((n) => n.id),
      ['b'],
    )
  })

  test('a menu with nothing to land on yields no index', () => {
    assert.equal(nextItemIndex(0, -1, 'down'), null)
    assert.equal(nextItemIndex(0, -1, 'home'), null)
  })

  test('the first Down from nowhere lands on the first item', () => {
    assert.equal(nextItemIndex(3, -1, 'down'), 0)
  })

  test('the first Up from nowhere lands on the last', () => {
    // Opening a menu and pressing Up to reach the bottom entry is a habit worth
    // honouring; without the wrap it silently goes to the top instead.
    assert.equal(nextItemIndex(3, -1, 'up'), 2)
  })

  test('both ends wrap', () => {
    assert.equal(nextItemIndex(3, 2, 'down'), 0)
    assert.equal(nextItemIndex(3, 0, 'up'), 2)
  })

  test('Home and End do not wrap', () => {
    assert.equal(nextItemIndex(3, 1, 'home'), 0)
    assert.equal(nextItemIndex(3, 1, 'end'), 2)
  })
})

describe('the confirm swap', () => {
  const labels = { cancel: 'Cancel' }

  test('cancel comes first, so the arming press cannot also fire it', () => {
    const nodes = confirmNodes(item('conn.forget', { confirm: 'Remove for good' }), labels, () => {})
    assert.deepEqual(
      nodes.map((n) => (n.kind === 'item' ? n.label : n.kind)),
      ['Cancel', 'Remove for good'],
    )
  })

  test('the armed line keeps its id and turns danger', () => {
    const nodes = confirmNodes(item('conn.forget', { confirm: 'Remove for good' }), labels, () => {})
    const armed = nodes[1]
    assert.equal(armed.kind, 'item')
    assert.equal(armed.id, 'conn.forget')
    assert.equal(armed.kind === 'item' ? armed.tone : null, 'danger')
  })

  test('arming does not act — only the confirmed line calls onSelect', () => {
    let fired = 0
    const source = item('conn.forget', {
      confirm: 'Remove for good',
      onSelect: () => {
        fired += 1
      },
    })
    const nodes = confirmNodes(source, labels, () => {})
    assert.equal(fired, 0, 'building the confirm menu must not act')

    const cancel = nodes[0]
    if (cancel.kind === 'item') cancel.onSelect()
    assert.equal(fired, 0, 'cancel must not act either')

    const armed = nodes[1]
    if (armed.kind === 'item') armed.onSelect()
    assert.equal(fired, 1)
  })

  test('cancel calls back so the menu can restore itself', () => {
    let cancelled = 0
    const nodes = confirmNodes(item('x', { confirm: 'Do it' }), labels, () => {
      cancelled += 1
    })
    const cancel = nodes[0]
    if (cancel.kind === 'item') cancel.onSelect()
    assert.equal(cancelled, 1)
  })

  test('an item with no confirm label falls back to its own', () => {
    const nodes = confirmNodes(item('x'), labels, () => {})
    assert.equal(nodes[1].kind === 'item' ? nodes[1].label : null, 'x')
  })
})

describe('placement', () => {
  const viewport = { width: 1000, height: 800 }
  const size = { width: 200, height: 300 }

  test('room below and to the right: the menu starts at the pointer', () => {
    assert.deepEqual(placeMenu({ x: 100, y: 100 }, size, viewport), { x: 100, y: 100 })
  })

  test('no room below: it flips above the pointer rather than sliding', () => {
    // The bug this replaces: a fixed 260px estimate slid the menu upwards until
    // it fitted, which put its middle under the cursor. Flipping keeps a corner
    // on the pointer, which is what makes a menu feel attached to the click.
    assert.deepEqual(placeMenu({ x: 100, y: 700 }, size, viewport), { x: 100, y: 400 })
  })

  test('no room to the right: it flips to the left of the pointer', () => {
    assert.deepEqual(placeMenu({ x: 900, y: 100 }, size, viewport), { x: 700, y: 100 })
  })

  test('the bottom-right corner flips on both axes at once', () => {
    assert.deepEqual(placeMenu({ x: 950, y: 780 }, size, viewport), { x: 750, y: 480 })
  })

  test('taller than the window: clamped, with the edge gap kept', () => {
    const tall = { width: 200, height: 900 }
    assert.deepEqual(placeMenu({ x: 100, y: 400 }, tall, viewport), {
      x: 100,
      y: MENU_EDGE_GAP,
    })
  })

  test('a click in the top-left corner never places the menu off-screen', () => {
    const { x, y } = placeMenu({ x: 2, y: 2 }, size, viewport)
    assert.ok(x >= 0 && y >= 0)
  })
})
