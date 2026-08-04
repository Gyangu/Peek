import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The connection sidebar's collapse state.
 *
 * Worth its own tests for the same reason the rail's are (see
 * `components/chat/__tests__/rail-store.test.ts`): the store reads `localStorage`
 * at module scope, and production loads the renderer from `file://`, where a
 * document can be denied storage outright. A throw there happens during module
 * init and takes the window down with it — a failure the dev server, served over
 * http, never reproduces.
 *
 * These also stand as the tests for `persistedFlag`, which both stores now share.
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

const { useSidebarStore, setSidebarCollapsed, toggleSidebar, resetSidebarForTest } = await import(
  '../sidebarStore'
)

const KEY = 'peek.sidebar.collapsed'

test('sidebar: starts expanded when nothing is stored', () => {
  store.clear()
  denied = false
  resetSidebarForTest()
  assert.equal(useSidebarStore.getState().collapsed, false)
})

test('sidebar: a stored collapse survives a reload', () => {
  store.clear()
  denied = false
  store.set(KEY, '1')
  resetSidebarForTest()
  assert.equal(useSidebarStore.getState().collapsed, true)
})

test('sidebar: toggling writes both ways', () => {
  store.clear()
  denied = false
  resetSidebarForTest()

  toggleSidebar()
  assert.equal(useSidebarStore.getState().collapsed, true)
  assert.equal(store.get(KEY), '1')

  toggleSidebar()
  assert.equal(useSidebarStore.getState().collapsed, false)
  // '0' rather than a delete: an explicit "expanded" is what stops a future
  // change of default from re-collapsing a sidebar the user already opened.
  assert.equal(store.get(KEY), '0')
})

test('sidebar: setting the state it already has writes nothing', () => {
  store.clear()
  denied = false
  resetSidebarForTest()

  setSidebarCollapsed(false)
  assert.equal(store.has(KEY), false)
})

test('sidebar: its key is its own — collapsing one side leaves the other alone', () => {
  store.clear()
  denied = false
  store.set('peek.chatRail.collapsed', '1')
  resetSidebarForTest()

  assert.equal(useSidebarStore.getState().collapsed, false)
  toggleSidebar()
  assert.equal(store.get('peek.chatRail.collapsed'), '1')
})

test('sidebar: denied storage neither throws nor loses the toggle', () => {
  store.clear()
  denied = false
  resetSidebarForTest()

  denied = true
  assert.doesNotThrow(() => {
    resetSidebarForTest()
  })
  assert.equal(useSidebarStore.getState().collapsed, false)

  assert.doesNotThrow(() => {
    toggleSidebar()
  })
  // The preference is lost on the next launch; the session still honours it.
  assert.equal(useSidebarStore.getState().collapsed, true)
})
