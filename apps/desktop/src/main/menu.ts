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
 * Not here on purpose: a **Settings…** item. `⌘,` is handled in the renderer
 * (`useGlobalKeys`), and a menu item carrying that accelerator would take the
 * chord away from it and then need an IPC channel to give the same behaviour
 * back. The dialog is reachable from the title-bar gear and from `⌘,`; adding a
 * third door is not worth a new channel.
 */

import { Menu, app, type MenuItemConstructorOptions } from 'electron'

export interface AppMenuOptions {
  /** Dev builds get the reload/devtools items; packaged builds do not. */
  isDev: boolean
  /** `1` larger, `-1` smaller, `0` actual size. */
  onZoom: (step: 1 | -1 | 0) => void
}

export function installAppMenu(options: AppMenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template(options)))
}

function template({ isDev, onZoom }: AppMenuOptions): MenuItemConstructorOptions[] {
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
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => { onZoom(0) } },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => { onZoom(1) } },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => { onZoom(-1) } },
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
        ? ([{ role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }] satisfies MenuItemConstructorOptions[])
        : ([{ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] satisfies MenuItemConstructorOptions[])),
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
