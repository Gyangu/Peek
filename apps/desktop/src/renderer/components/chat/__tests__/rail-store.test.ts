import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The conversation rail's collapse state.
 *
 * Worth its own tests for one reason: the store reads and writes `localStorage`
 * at module scope, and production loads the renderer from `file://`, where a
 * document can be denied storage outright. A throw there would happen during
 * module init and take the window down with it — which is exactly the failure a
 * unit test can catch and a manual pass cannot, because the dev server is served
 * over http and never sees it.
 */

interface StorageStub {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const store = new Map<string, string>()
let denied = false

const stub: StorageStub = {
  getItem: (key) => {
    if (denied) throw new Error('storage denied')
    return store.get(key) ?? null
  },
  setItem: (key, value) => {
    if (denied) throw new Error('storage denied')
    store.set(key, value)
  },
}

;(globalThis as { localStorage?: unknown }).localStorage = stub

const { useChatRailStore, setChatRailCollapsed, toggleChatRail, resetChatRailForTest } = await import(
  '../railStore'
)

const KEY = 'peek.chatRail.collapsed'

test('rail: starts expanded when nothing is stored', () => {
  store.clear()
  denied = false
  resetChatRailForTest()
  assert.equal(useChatRailStore.getState().collapsed, false)
})

test('rail: a stored collapse survives a reload', () => {
  store.clear()
  denied = false
  store.set(KEY, '1')
  resetChatRailForTest()
  assert.equal(useChatRailStore.getState().collapsed, true)
})

test('rail: toggling writes both ways', () => {
  store.clear()
  denied = false
  resetChatRailForTest()

  toggleChatRail()
  assert.equal(useChatRailStore.getState().collapsed, true)
  assert.equal(store.get(KEY), '1')

  toggleChatRail()
  assert.equal(useChatRailStore.getState().collapsed, false)
  // '0' rather than a delete: an explicit "expanded" is what stops a future
  // change of default from re-collapsing a rail the user already opened.
  assert.equal(store.get(KEY), '0')
})

test('rail: setting the state it already has writes nothing', () => {
  store.clear()
  denied = false
  resetChatRailForTest()

  setChatRailCollapsed(false)
  assert.equal(store.has(KEY), false)
})

test('rail: denied storage neither throws nor loses the toggle', () => {
  store.clear()
  denied = false
  resetChatRailForTest()

  denied = true
  assert.doesNotThrow(() => {
    resetChatRailForTest()
  })
  assert.equal(useChatRailStore.getState().collapsed, false)

  assert.doesNotThrow(() => {
    toggleChatRail()
  })
  // The preference is lost on the next launch; the session still honours it.
  assert.equal(useChatRailStore.getState().collapsed, true)
})
