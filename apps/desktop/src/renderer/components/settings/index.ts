/**
 * The settings dialog.
 *
 * Only the shell is exported: the sections are its private business, and nothing
 * outside should be able to render one on its own. To open the dialog — from a
 * button, a shortcut, a hint — call `openSettings()` from
 * `state/settingsDialogStore`.
 */
export { SettingsDialog } from './SettingsDialog'
