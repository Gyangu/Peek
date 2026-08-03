import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { PLUGIN_CSP, PLUGIN_SCHEME, pluginUiRootFrom, resolvePluginAsset } from './assets'

/* ==================================================================
 * `peek-plugin://` — the origin a self-drawn (Tier C) plugin view draws inside.
 *
 * See `docs/design/2026-08-03-plugin-architecture.md` §2.6. The one rule the
 * whole scheme exists to keep is that **the window's `script-src 'self'` is
 * never relaxed**: no plugin JavaScript enters the host realm. A plugin that
 * wants to draw its own view gets an `<iframe>` on an origin of its own instead,
 * and one `MessagePort` for everything it needs from peek.
 *
 * ## Why a custom scheme and not `file://`
 *
 * Two things `loadFile` cannot do, both of them load-bearing:
 *
 * 1. **A real origin per plugin.** `standard: true` makes `peek-plugin://neo4j`
 *    an origin the same way `https://example.com` is one, so two plugins are
 *    cross-origin to each other and to the window. Every `file://` document, by
 *    contrast, is either one opaque origin or — with `webSecurity` relaxed —
 *    all of them at once.
 * 2. **Response headers.** The document CSP is a header, and a header is the
 *    only form of CSP a frame cannot remove. A `<meta>` tag in a file the plugin
 *    ships is a CSP the *plugin* controls, which is not a CSP at all.
 *
 * ## What is deliberately absent from the privileges
 *
 * `supportFetchAPI`, `corsEnabled` and `allowServiceWorkers` are all left off.
 * The document CSP already carries `connect-src 'none'`, so this is a second,
 * independent statement of the same rule: **a plugin UI has no network and no
 * background lifetime**, and its only I/O is the port. Two mechanisms rather
 * than one because they fail differently — a header can be got wrong in this
 * file, a privilege cannot be got wrong from inside the frame.
 *
 * The decision of *which file a URL means* lives in `./assets`, which imports no
 * electron and is therefore testable.
 * ================================================================== */

/**
 * Register the scheme's privileges.
 *
 * **Must run before `app.whenReady()`**, and Electron does not merely prefer
 * that — `registerSchemesAsPrivileged` after ready is ignored, and the failure
 * is a frame that loads with an opaque origin and no secure context rather than
 * an error. Called at module scope in `main/index.ts` for that reason.
 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        allowServiceWorkers: false,
      },
    },
  ])
}

/**
 * Install the handler. Must run after `app.whenReady()`.
 *
 * Every failure is a plain 404 rather than a throw: this runs once per
 * subresource, and a rejected promise here surfaces as a frame that loads
 * nothing, with no reason recorded anywhere. The view's own "the frame never
 * answered" message (`PluginFrame`) is what a person sees instead.
 */
export function installPluginProtocol(): void {
  const root = pluginUiRootFrom(import.meta.dirname)

  protocol.handle(PLUGIN_SCHEME, async (request) => {
    const target = resolvePluginAsset(request.url, root)
    if (target === null) return notFound()
    try {
      const body = await readFile(target.file)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type': target.mediaType,
          'content-security-policy': PLUGIN_CSP,
          // The media type comes from a whitelist, so this only matters when the
          // whitelist and the bytes disagree — which is exactly the case where
          // sniffing would pick the dangerous answer.
          'x-content-type-options': 'nosniff',
          // A plugin's UI is a build artefact of the app, not user data, and it
          // changes only when the app is rebuilt. A cached copy would outlive
          // that rebuild inside a store nobody thinks to clear while debugging a
          // plugin.
          'cache-control': 'no-store',
        },
      })
    } catch {
      // A missing file is the ordinary shape of "this plugin's UI was never
      // built" — `pnpm build:plugin-ui` is a separate pass. Nothing to log per
      // subresource; the view says it once.
      return notFound()
    }
  })
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
}
