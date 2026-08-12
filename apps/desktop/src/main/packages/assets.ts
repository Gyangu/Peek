import { join, normalize, resolve, sep } from 'node:path'
import { PACKAGE_ID_PATTERN } from '@peek/core'

/* ==================================================================
 * Which file a `peek-package://` URL means, and what may be said about it.
 *
 * Split from `protocol.ts` — which does the Electron wiring — because this half
 * is the half that decides whether a URL escapes its package's directory, and a
 * module that imports `electron` cannot be run by a test outside Electron. The
 * check that matters is therefore the one that would have been hardest to cover,
 * which is the wrong way round. Here it is a pure function of a string.
 * ================================================================== */

export const PACKAGE_SCHEME = 'peek-package'

/**
 * The scheme's privileges, declared here rather than inline at the
 * `registerSchemesAsPrivileged` call so that a test can read them without
 * importing `electron`.
 *
 * **Three of these are `false` against the common advice**, and that is the
 * point of pinning them: the usual recipe for a package scheme turns on
 * `supportFetchAPI` and `corsEnabled` so the frame can talk to a local server.
 * peek's frames talk to nothing — the document CSP carries `connect-src 'none'`
 * and the only I/O is one MessagePort. Two independent statements of one rule,
 * because they fail differently: a header can be got wrong in this file, a
 * privilege cannot be got wrong from inside the frame.
 *
 * So `hardening.test.ts` asserts these stay false. Someone tidying this
 * up against a tutorial would otherwise open a network path for every package,
 * and nothing else in the build would notice.
 */
export const PACKAGE_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: false,
  corsEnabled: false,
  allowServiceWorkers: false,
} as const

/**
 * The document CSP served with every package page. Tighter than VS Code's webview
 * CSP, and each clause is doing something:
 *
 * - `default-src 'none'` — everything is denied unless named below.
 * - `script-src 'self'` — the package's own bundle only. No `'unsafe-inline'`,
 *   which is why a package's `index.html` may not carry a `<script>` body: an
 *   inline block is silently not executed and the frame comes up blank.
 * - `style-src 'self' 'unsafe-inline'` — inline styles are how a canvas view
 *   positions a tooltip; with `connect-src 'none'` and no remote `img-src` there
 *   is nothing for one to exfiltrate through.
 * - `connect-src 'none'` — the whole point. No fetch, no XHR, no WebSocket, no
 *   `EventSource`. A package that wants data asks the host over the port, and the
 *   host is what decides.
 * - `frame-src 'none'` — a package cannot nest a frame, so it cannot reach an
 *   origin it was not given by making one.
 * - `form-action 'none'` / `base-uri 'none'` — a form post and a rewritten
 *   `<base>` are both ways to cause a navigation the clauses above do not
 *   describe.
 */
export const PACKAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Extension → media type. Anything not here is refused rather than guessed at. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/**
 * The one directory of a package that is reachable over the scheme.
 *
 * A package directory holds `peek-package.json`, `driver.mjs` and `contrib.mjs`
 * beside `ui/`, and those three are exactly the files no frame may read: the
 * manifest names the fields a connect form fills, and the other two are the
 * code that runs with the credentials. Serving `<packages>/<id>/` directly would
 * hand a frame its own package's implementation, so the served root is one level
 * in — the layout in design §2.2, applied here.
 */
export const PACKAGE_UI_DIR = 'ui'

export interface PackageAsset {
  file: string
  mediaType: string
}

/**
 * Resolve `peek-package://<host>/<path>` to a file under `<root>/<id>/ui/`, or null.
 *
 * `root` is `<configDir>/packages` — a directory the **user** writes to, not a
 * build output. That is a change of what is on the other side of this function
 * and not a change to the function: the containment check is a prefix test on
 * the **resolved** path rather than a scan for `..` in the URL, which is the
 * form that holds when the tree can contain anything (`%2e%2e` decodes after
 * such a scan would have run, and a symlink defeats a textual check entirely).
 * Resolving first and comparing after was written for exactly this day.
 *
 * Null for anything that leaves `<root>/<packageId>/ui/`, including the package's
 * own manifest and entry files one level above it.
 */
export function resolvePackageAsset(rawUrl: string, root: string): PackageAsset | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PACKAGE_SCHEME}:`) return null

  const packageId = parsed.hostname
  // The id class is enforced on the URL host rather than trusted from whatever
  // produced it, because in Phase C that is a scan of a directory the user
  // writes to. `PACKAGE_ID_PATTERN` itself, not a copy: the same class decides
  // what `DriverIdSchema` accepts and what a scan cursor may be prefixed with,
  // and three regexes that have to agree are two chances to widen one alone.
  // `scripts/build-packages.mjs` applies the same import when it decides which
  // directory a package installs as, so an id that would 404 fails the build.
  if (!PACKAGE_ID_PATTERN.test(packageId)) return null

  const base = join(root, packageId, PACKAGE_UI_DIR)
  let decoded: string
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    // A malformed percent-escape is not a path. Refusing beats letting the raw
    // bytes through, which is the version of this that has a `%2e%2e` hole.
    return null
  }
  // A NUL truncates the path for some syscalls but not for the string compare
  // above it, which is the classic way a containment check and the open() it
  // guards end up disagreeing about which file is meant.
  if (decoded.includes('\0')) return null

  const file = resolve(join(base, normalize(decoded)))
  if (file !== base && !file.startsWith(base + sep)) return null

  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot).toLowerCase()
  const mediaType = MEDIA_TYPES[ext]
  // An unknown extension is refused rather than served as
  // `application/octet-stream`. Serving it would leave the *browser* to decide
  // what a package's file is, and the one thing worse than a refused asset is one
  // sniffed into a script.
  if (mediaType === undefined) return null

  return { file, mediaType }
}
