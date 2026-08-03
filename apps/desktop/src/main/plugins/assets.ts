import { join, normalize, resolve, sep } from 'node:path'

/* ==================================================================
 * Which file a `peek-plugin://` URL means, and what may be said about it.
 *
 * Split from `protocol.ts` — which does the Electron wiring — because this half
 * is the half that decides whether a URL escapes its plugin's directory, and a
 * module that imports `electron` cannot be run by a test outside Electron. The
 * check that matters is therefore the one that would have been hardest to cover,
 * which is the wrong way round. Here it is a pure function of a string.
 * ================================================================== */

export const PLUGIN_SCHEME = 'peek-plugin'

/**
 * The document CSP served with every plugin page. Tighter than VS Code's webview
 * CSP, and each clause is doing something:
 *
 * - `default-src 'none'` — everything is denied unless named below.
 * - `script-src 'self'` — the plugin's own bundle only. No `'unsafe-inline'`,
 *   which is why a plugin's `index.html` may not carry a `<script>` body: an
 *   inline block is silently not executed and the frame comes up blank.
 * - `style-src 'self' 'unsafe-inline'` — inline styles are how a canvas view
 *   positions a tooltip; with `connect-src 'none'` and no remote `img-src` there
 *   is nothing for one to exfiltrate through.
 * - `connect-src 'none'` — the whole point. No fetch, no XHR, no WebSocket, no
 *   `EventSource`. A plugin that wants data asks the host over the port, and the
 *   host is what decides.
 * - `frame-src 'none'` — a plugin cannot nest a frame, so it cannot reach an
 *   origin it was not given by making one.
 * - `form-action 'none'` / `base-uri 'none'` — a form post and a rewritten
 *   `<base>` are both ways to cause a navigation the clauses above do not
 *   describe.
 */
export const PLUGIN_CSP = [
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

/**
 * A servable plugin id.
 *
 * Enforced on the URL host rather than trusted from whatever produced it,
 * because in Phase C that is a scan of a directory the user writes to. A dot is
 * refused along with the separators: it costs dotted ids (`com.example.thing`)
 * and buys not having to reason about whether `..` survives URL host parsing on
 * every platform — worth it while the ids are still ours to choose, and a
 * decision to revisit in Phase C rather than a rule to work around.
 *
 * `scripts/build-plugin-ui.mjs` applies the same pattern when it decides where
 * to build, so a package whose id would 404 fails the build instead.
 */
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/

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
 * Where a plugin's built UI lives: `out/plugin-ui/<pluginId>/…`.
 *
 * Built by a Vite pass of its own (`scripts/build-plugin-ui.mjs`) rather than as
 * an extra input to the window's build, and that separation is not tidiness: one
 * Rollup graph is allowed to hoist common code into a shared chunk, and a chunk
 * shared between the host realm and a plugin realm is the one thing this whole
 * scheme exists to prevent. Two graphs cannot share one.
 *
 * Takes the root as an argument so a test can point it at a fixture. Main passes
 * the real one, derived from where its own bundle sits.
 */
export function pluginUiRootFrom(mainDir: string): string {
  return resolve(join(mainDir, '..', 'plugin-ui'))
}

export interface PluginAsset {
  file: string
  mediaType: string
}

/**
 * Resolve `peek-plugin://<host>/<path>` to a file under `root`, or null.
 *
 * Null for anything that leaves `<root>/<pluginId>/`. The containment check is a
 * prefix test on the **resolved** path rather than a scan for `..` in the URL:
 * `%2e%2e` decodes after such a scan would have run, and a symlink defeats a
 * textual check entirely. Resolving first and comparing after is the only form
 * that holds for both.
 */
export function resolvePluginAsset(rawUrl: string, root: string): PluginAsset | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PLUGIN_SCHEME}:`) return null

  const pluginId = parsed.hostname
  if (!PLUGIN_ID.test(pluginId)) return null

  const base = join(root, pluginId)
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
  // what a plugin's file is, and the one thing worse than a refused asset is one
  // sniffed into a script.
  if (mediaType === undefined) return null

  return { file, mediaType }
}
