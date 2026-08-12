import { registerHooks } from 'node:module'

/**
 * Point the bare specifier `electron` at {@link ./stub-electron}.
 *
 * **Import this, then reach the modules under test through `await import(...)`.**
 * A static import graph is resolved in full before any of it is evaluated, so a
 * hook registered by one static import cannot affect a sibling static import —
 * the redirect would be installed after `host-process.ts` had already failed to
 * resolve. `bus/__tests__/deadline-escalation.test.ts` does the same dance for
 * the same reason.
 *
 * Redirecting the bare specifier rather than peek's own module is the deliberate
 * half; `stub-electron.ts` explains why.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== 'electron') return nextResolve(specifier, context)
    // Resolved through `nextResolve` rather than hand-built, so the result
    // carries the format node infers for a `.ts` file on its own.
    return nextResolve('./stub-electron.ts', { ...context, parentURL: import.meta.url })
  },
})
