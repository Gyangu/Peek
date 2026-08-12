import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { PACKAGE_CSP, PACKAGE_SCHEME, PACKAGE_SCHEME_PRIVILEGES, resolvePackageAsset } from './assets'

/* ==================================================================
 * `peek-package://` — the origin a self-drawn (Tier C) package view draws inside.
 *
 * See `docs/design/2026-08-03-plugin-architecture.md` §2.6. The one rule the
 * whole scheme exists to keep is that **the window's `script-src 'self'` is
 * never relaxed**: no package JavaScript enters the host realm. A package that
 * wants to draw its own view gets an `<iframe>` on an origin of its own instead,
 * and one `MessagePort` for everything it needs from peek.
 *
 * ## Why a custom scheme and not `file://`
 *
 * Two things `loadFile` cannot do, both of them load-bearing:
 *
 * 1. **A real origin per package.** `standard: true` makes `peek-package://neo4j`
 *    an origin the same way `https://example.com` is one, so two packages are
 *    cross-origin to each other and to the window. Every `file://` document, by
 *    contrast, is either one opaque origin or — with `webSecurity` relaxed —
 *    all of them at once.
 * 2. **Response headers.** The document CSP is a header, and a header is the
 *    only form of CSP a frame cannot remove. A `<meta>` tag in a file the package
 *    ships is a CSP the *package* controls, which is not a CSP at all.
 *
 * ## What is deliberately absent from the privileges
 *
 * `supportFetchAPI`, `corsEnabled` and `allowServiceWorkers` are all left off.
 * The document CSP already carries `connect-src 'none'`, so this is a second,
 * independent statement of the same rule: **a package UI has no network and no
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
export function registerPackageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // The privileges themselves live in `./assets` so that a test can pin them
    // without importing electron — see `PACKAGE_SCHEME_PRIVILEGES` for which ones
    // are deliberately false and why tidying them "up" would open a hole.
    { scheme: PACKAGE_SCHEME, privileges: { ...PACKAGE_SCHEME_PRIVILEGES } },
  ])
}

/**
 * Install the handler. Must run after `app.whenReady()`.
 *
 * `packagesRoot` is `<configDir>/packages` — the same directory the loader
 * scans, passed in rather than derived here so that the two cannot point at
 * different trees (`config/paths.ts` holds the one function both call). It moved
 * there from the build's own UI output tree with design §2.2: a package's UI
 * ships inside the package, so it lives wherever the package was installed.
 *
 * Every failure is a plain 404 rather than a throw: this runs once per
 * subresource, and a rejected promise here surfaces as a frame that loads
 * nothing, with no reason recorded anywhere. The view's own "the frame never
 * answered" message (`PackageFrame`) is what a person sees instead.
 */
export function installPackageProtocol(packagesRoot: string): void {
  protocol.handle(PACKAGE_SCHEME, async (request) => {
    const target = resolvePackageAsset(request.url, packagesRoot)
    if (target === null) return notFound()
    try {
      const body = await readFile(target.file)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'content-type': target.mediaType,
          'content-security-policy': PACKAGE_CSP,
          // The media type comes from a whitelist, so this only matters when the
          // whitelist and the bytes disagree — which is exactly the case where
          // sniffing would pick the dangerous answer.
          'x-content-type-options': 'nosniff',
          // A package's UI is a build artefact of the app, not user data, and it
          // changes only when the app is rebuilt. A cached copy would outlive
          // that rebuild inside a store nobody thinks to clear while debugging a
          // package.
          'cache-control': 'no-store',
        },
      })
    } catch {
      // A missing file is the ordinary shape of "this package ships no UI, or
      // is not installed here" — the tree under `<configDir>/packages` is the
      // user's, so a package can be absent between one launch and the next.
      // Nothing to log per subresource; the view says it once.
      return notFound()
    }
  })
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
}
