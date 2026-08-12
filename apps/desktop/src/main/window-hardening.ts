import type { BrowserWindow } from 'electron'
import { shell } from 'electron'
import { isExternalLink } from './external-link'

/* ==================================================================
 * Everything a peek window refuses to do.
 *
 * Lifted out of `index.ts` for one reason: **the probe has to exercise the real
 * function.** These three rules (no new windows, no navigation, no permissions)
 * cannot be unit-tested — they are Chromium behaviour, not arithmetic — so the
 * only honest check is an Electron run that tries each one and watches it fail
 * (`scripts/probe-hardening.mjs`, design 2026-08-07 §4.8 items 36–37). A probe
 * that re-implemented these rules would be grading its own copy.
 *
 * The first run of that probe found the cost of the gap: `will-frame-navigate`
 * fires for a frame's **own first load**, so this function was refusing every
 * package view its document. See `refuseNavigation`.
 *
 * The pure part — which URLs may reach the system browser — lives one module
 * further out in `./external-link`, where `node --test` can reach it.
 * ================================================================== */

/**
 * Refuse new windows, refuse navigation, refuse every permission.
 *
 * Call once per window, after `webContents` exists.
 *
 * ## Why three rules and not one
 *
 * They cover three different ways out of the page, and each is invisible to the
 * others:
 *
 * - `setWindowOpenHandler` sees `window.open` and `target=_blank` — **and
 *   nothing else**. A comment in `index.ts` used to claim it refused off-site
 *   navigation; it never did.
 * - `will-navigate` sees `location.href = …` in the **main frame only**.
 * - `will-frame-navigate` sees the same in subframes, which is where every
 *   database package's own view lives. Without it, a package document could move
 *   its own frame anywhere its CSP allows.
 *
 * ## Reloads are allowed through, deliberately
 *
 * The dev server's full-reload path is a navigation to the URL already loaded.
 * Refusing it would break HMR while protecting nothing: the destination is the
 * document that is already there.
 */
export function hardenWindow(win: BrowserWindow): void {
  // A new window is never opened in-app. An http(s) link is handed to the
  // system browser; anything else is dropped. The scheme test is not decoration
  // — `shell.openExternal` will hand a `file://` path to Finder, so an
  // unfiltered call is a package-triggered "open this local thing" primitive.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /**
   * `event.frame` is on both event payloads, so one function still serves both.
   * Declared structurally rather than as Electron's `WebFrameMain` because `url`
   * is the only thing read, and a narrower type is a narrower promise.
   */
  const refuseNavigation = (
    event: { preventDefault(): void; frame: { url: string } | null },
    url: string,
  ): void => {
    if (url === win.webContents.getURL()) return
    // A frame with no document yet is **arriving, not leaving**, and refusing it
    // refuses the package view itself: `will-frame-navigate` fires for an
    // iframe's own first load, which is how every Tier C view got its document.
    // Design §2.10 draws the line in exactly this place — "`frame-src` decides
    // whether it may load, this decides where it may jump afterwards" — so the
    // guard that also blocked the load was doing `frame-src`'s job and doing it
    // wrong. Unforgeable in the direction that matters: a frame cannot get back
    // to having no document, because that navigation is itself refused here.
    const from = event.frame?.url ?? ''
    if (from === '' || from === 'about:blank') return
    event.preventDefault()
    console.error(`[peek/error] refused an in-window navigation to ${url}`)
  }
  win.webContents.on('will-navigate', (event, url) => refuseNavigation(event, url))
  win.webContents.on('will-frame-navigate', (event) => refuseNavigation(event, event.url))

  // Camera, microphone, geolocation, notifications, clipboard, MIDI — peek needs
  // none of them, in the window or in any package frame. Both handlers are set:
  // one answers a prompt, the other answers the synchronous query some APIs make
  // before prompting, and a missing handler means Chromium's default rather than
  // a refusal.
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  win.webContents.session.setPermissionCheckHandler(() => false)
}
