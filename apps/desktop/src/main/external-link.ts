/* ==================================================================
 * Which URLs may leave peek for the system browser.
 *
 * A module of its own, and not because `index.ts` was crowded: `index.ts`
 * imports `electron` at the top level, so nothing in it can be reached by
 * `node --test`. This is the one decision on that path with a wrong answer that
 * costs something, so it is the one that had to stay testable — the same split
 * `packages/assets.ts` makes away from `packages/protocol.ts`.
 * ================================================================== */

/**
 * Whether a URL is something the *system browser* should be handed.
 *
 * `shell.openExternal` is not a browser call. It is "ask the OS to do whatever
 * it does with this", and the OS does plenty: `file:` opens a path in Finder,
 * and a registered custom scheme starts whatever registered it. The caller is a
 * link click that may have come from a database package's own view, so an
 * unfiltered `openExternal` would be a package-triggered "open this local thing"
 * primitive.
 *
 * Hence an allowlist of two schemes rather than a denylist of the ones thought
 * of today. A URL that does not parse is not external — it is not anything.
 *
 * Note this says nothing about *navigation*: `setWindowOpenHandler` denies every
 * new window regardless, and in-window navigation is refused separately
 * (`will-navigate` / `will-frame-navigate` in `index.ts`). This function only
 * decides whether, having refused to open it here, peek also offers it to the
 * browser.
 */
export function isExternalLink(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
