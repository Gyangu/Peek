import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The application menu's arm in the renderer.
 *
 * `applyMenuAction` is tested and `useMenuActions` is not, which is the same
 * split `shortcuts.ts` and `useGlobalKeys.ts` already have: the translation is
 * where the decisions are, the subscription around it is three lines of React.
 *
 * These matter more than their size suggests. On macOS the menu item owns `⌘,`
 * outright — the accelerator is resolved before the keystroke reaches the web
 * contents — so this path is not a second way into the settings dialog, it is
 * the only one. See `docs/design/2026-08-04-settings-into-app-menu.md` §2.2.
 */

const { applyMenuAction } = await import('../useMenuActions')
const { useSettingsDialogStore, closeSettings, DEFAULT_SETTINGS_SECTION } = await import(
  '../../state/settingsDialogStore'
)

const section = (): string | null => useSettingsDialogStore.getState().section

test('openSettings lands on the default section', () => {
  closeSettings()
  applyMenuAction({ action: 'openSettings' })
  assert.equal(section(), DEFAULT_SETTINGS_SECTION)
})

test('an already-open dialog goes back to the default section, exactly as ⌘, does', () => {
  closeSettings()
  useSettingsDialogStore.getState().open('about')
  applyMenuAction({ action: 'openSettings' })
  // `openSettings()` with no argument has always meant "the default section",
  // and that is what `useGlobalKeys` has always sent. The menu item inherits the
  // chord on macOS, so it has to inherit the behaviour with it — this test is
  // here to catch the two drifting apart, not to argue the behaviour is ideal.
  assert.equal(section(), DEFAULT_SETTINGS_SECTION)
})

test('an unknown action from a mismatched build is dropped, not thrown on', () => {
  closeSettings()
  assert.doesNotThrow(() => {
    // A build where main knows a menu action this renderer does not. Cast
    // because the type is exactly what stops this happening at compile time.
    applyMenuAction({ action: 'somethingNewer' } as unknown as { action: 'openSettings' })
  })
  assert.equal(section(), null)
})
