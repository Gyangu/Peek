import { registerHooks } from 'node:module'

/**
 * Point `connections/host-process` and `connections/port-broker` at their stubs.
 *
 * **Import this before importing anything that reaches `connections/manager`**,
 * or the real modules resolve first and the test dies on `MessageChannelMain is
 * not defined` — a failure that points at a file the test never mentioned.
 *
 * A `resolve` hook rather than a `load` hook returning source: the stubs are
 * ordinary modules in the repository, so `tsc` checks them and the test can
 * import them directly to read what they recorded. The previous arrangement
 * inlined them as JavaScript strings, which typechecked as text and could only
 * be configured through a global.
 *
 * Design record: docs/design/2026-08-02-connection-manager-stubs.md
 */

const REDIRECTS: Readonly<Record<string, string>> = {
  'connections/host-process': './stub-host-process.ts',
  'connections/port-broker': './stub-port-broker.ts',
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    for (const [suffix, stub] of Object.entries(REDIRECTS)) {
      // Matched on the resolved URL, not the specifier: manager.ts spells these
      // './host-process', while a test importing them directly spells something
      // else entirely.
      if (resolved.url.endsWith(`${suffix}.ts`)) {
        return { ...resolved, url: new URL(stub, import.meta.url).href }
      }
    }
    return resolved
  },
})
