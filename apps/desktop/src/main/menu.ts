/**
 * The application menu.
 *
 * peek shipped without one, which does not mean it had none — it means it had
 * **Electron's**, and that default is wrong for this app in two specific ways:
 *
 * 1. **It hands the end user Reload, Force Reload and Toggle DevTools.** In a
 *    tool whose main surface is a table you scroll for minutes at a time, `⌘R`
 *    is a key people hit by accident, and it throws away every open view, every
 *    result set in the renderer cache and every scroll position. (Main survives
 *    it — the connections and driver processes are untouched — which is exactly
 *    what makes it look like a crash rather than a reload.) Those three stay,
 *    but only in a dev build, where the person hitting them wants them.
 *
 * 2. **Its Window menu binds `⌘W` to Close Window**, and `⌘W` is peek's own
 *    "close the visible tab" chord (`hooks/shortcuts.ts`). A menu accelerator is
 *    resolved before the keystroke ever reaches the web contents, so the default
 *    menu was quietly outranking the window's own keyboard model on the one
 *    chord users press most. The custom Window menu below offers Minimise, Zoom
 *    and Front and **deliberately no Close item** — peek is single-window, and
 *    the window is closed with the red light or `⌘Q`.
 *
 * What the default menu got right and this keeps: the Edit menu. `⌘C` / `⌘V` /
 * `⌘A` are `role`-based menu items on macOS and *stop working in text fields*
 * without them, which is the classic way a hand-written Electron menu breaks an
 * app. The grid's own `⌘C` (copy cells) is a renderer handler on a div, not a
 * text field, so the two do not collide: the role item only fires when the
 * focused element is an editable one.
 *
 * **Settings…** used to be excluded from here, on the argument that a menu item
 * carrying `⌘,` takes the chord away from the renderer's own handler and then
 * needs an IPC channel to give the behaviour back — not worth it for a third
 * door beside the title-bar gear and the shortcut. Half of that still holds: a
 * menu accelerator is resolved before the keystroke reaches the web contents,
 * so `⌘,` really does leave `useGlobalKeys` on macOS, and `IPC.MENU_ACTION`
 * really is a new channel. What changed is the other half — the gear is gone
 * from the title bar on macOS, so this is not a third door but *the* door, and
 * `applicationName → Settings…` is where a Mac user looks first. See
 * `docs/design/2026-08-04-settings-into-app-menu.md`.
 *
 * The item is macOS-only. Windows and Linux keep the gear, because their menu
 * bar is not the place anyone looks for preferences — §3.3 of that document.
 *
 * **Every accelerator written below is registered** in `renderer/keys/registry.ts`
 * with `scope: 'menu'`, and a test reads this file to prove it. That is what
 * turns the warning two paragraphs up from prose into something enforced: an
 * accelerator added here that collides with a window chord now fails a test
 * instead of silently taking the chord away. `Command+,` is registered as the
 * window's `app.settings` rather than as a menu entry of its own, because it is
 * the same action reached through a second door.
 */

import { Menu, app, type MenuItemConstructorOptions } from 'electron'

export interface AppMenuOptions {
  /** Dev builds get the reload/devtools items; packaged builds do not. */
  isDev: boolean
  /** `1` larger, `-1` smaller, `0` actual size. */
  onZoom: (step: 1 | -1 | 0) => void
  /**
   * macOS `Settings…`. Sends the renderer down `IPC.MENU_ACTION`; never called
   * on Windows or Linux, where the item does not exist.
   */
  onOpenSettings: () => void
}

export function installAppMenu(options: AppMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template(options)))
}

function template({ isDev, onZoom, onOpenSettings }: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = process.platform === 'darwin'

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      /*
       * Zoom goes through the callback rather than through Electron's
       * `zoomIn` / `zoomOut` roles. The roles step the web contents by a fixed
       * ratio and remember nothing, while peek's zoom is a persisted preference
       * with a floor and a ceiling — the floor exists so that zooming out cannot
       * push the 11px text minimum back under 9px, which is the whole point of
       * design/2026-08-02-ui-legibility-baseline.md.
       */
      {
        label: 'Actual Size',
        accelerator: 'CmdOrCtrl+0',
        click: () => {
          onZoom(0)
        },
      },
      {
        label: 'Zoom In',
        accelerator: 'CmdOrCtrl+Plus',
        click: () => {
          onZoom(1)
        },
      },
      {
        label: 'Zoom Out',
        accelerator: 'CmdOrCtrl+-',
        click: () => {
          onZoom(-1)
        },
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      ...(isDev
        ? ([
            { type: 'separator' },
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
    ],
  }

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
          ] satisfies MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ] satisfies MenuItemConstructorOptions[])),
    ],
  }

  // No Close item — see the note at the top of the file.
  const window: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }],
  }

  return [
    ...(mac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              /*
               * `label` + `click`, not `role: 'preferences'`: that role opens
               * nothing by itself (it is a label and an accelerator, and macOS
               * has no system-wide notion of an app's preferences window), so
               * the click handler is required either way and the role would only
               * hide where the string comes from. The ellipsis is the macOS
               * convention for "this opens something you then interact with".
               */
              { label: 'Settings…', accelerator: 'Command+,', click: onOpenSettings },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : ([{ label: 'File', submenu: [{ role: 'quit' }] }] satisfies MenuItemConstructorOptions[])),
    edit,
    view,
    window,
  ]
}
