/**
 * A boolean window preference, persisted best-effort.
 *
 * Both accesses are wrapped because production loads the renderer from `file://`
 * (`win.loadFile`), and a file-origin document can be denied storage outright
 * depending on how Chromium partitions it. Losing a preference is acceptable;
 * throwing during module init — which is when these stores read — and taking the
 * window down with it is not. The dev server is served over http and never sees
 * that failure, so it is a unit test's job, not a manual pass's.
 *
 * This exists because the caveat above had been written out twice already
 * (`i18n/store.ts`, `chat/railStore.ts`) and the sidebar's collapse state was
 * about to be the third. `i18n/store.ts` deliberately keeps its own copy: it
 * stores a `Locale` rather than a flag and has to initialise synchronously
 * before React mounts, so sharing this would need a generic that suits neither.
 *
 * See docs/design/2026-08-04-sidebar-collapse.md §2.3.
 */

export function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1'
  } catch {
    return false
  }
}

/**
 * Writes `'0'` rather than removing the key: an explicit "off" is what stops a
 * future change of default from re-collapsing something the user has opened.
 */
export function writeFlag(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0')
  } catch {
    // Best-effort: the session still honours the toggle.
  }
}
