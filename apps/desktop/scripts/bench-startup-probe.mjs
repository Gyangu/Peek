/**
 * Timing probe, injected into the app's **main process** by `bench-startup.mjs`
 * through `NODE_OPTIONS=--import`.
 *
 * It has to be injected rather than built in because the two interesting events
 * are main-process events on a `BrowserWindow` (`ready-to-show`, and the
 * webContents' `did-finish-load`), and neither leaves any trace in the app's
 * own output. The alternative — adding `console.log` calls to `src/main/index.ts`
 * — would put benchmark scaffolding in the shipped product and change the very
 * thing being measured. `--import` runs this module before the app entry, so the
 * listeners are registered before the window exists.
 *
 * Everything it emits is one line per event on stdout:
 *
 *     __PEEK_BENCH__ <event> <epoch-ms>
 *
 * Absolute epoch milliseconds, not deltas, because the origin the parent
 * measures from (the instant it called `spawn`) lives in the parent.
 */

import electron from 'electron'

const { app } = electron

/** Prefix chosen to be greppable and impossible to confuse with app logging. */
const mark = (name) => {
  process.stdout.write(`__PEEK_BENCH__ ${name} ${String(Date.now())}\n`)
}

mark('probe-loaded')

void app.whenReady().then(() => {
  mark('app-ready')
})

// `browser-window-created` rather than a poll: it fires synchronously inside the
// BrowserWindow constructor, so both listeners are attached before the window
// has had a chance to load anything.
app.on('browser-window-created', (_event, win) => {
  win.once('ready-to-show', () => {
    mark('ready-to-show')
  })
  win.webContents.once('did-finish-load', () => {
    mark('did-finish-load')
  })
})
