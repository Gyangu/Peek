import { resolve } from 'node:path'

/**
 * Optional dependencies of the bundled database clients, and the stub each one
 * resolves to.
 *
 * The drivers are bundled rather than externalized, so their npm dependencies
 * are bundled too — including specifiers those packages only reference behind a
 * feature flag and never ship installed: `pg-native` (pg's libpq backend),
 * `@opentelemetry/api` (@redis/client's instrumentation), `@node-rs/xxhash`
 * (@redis/client's `digest()`).
 *
 * Vite compiles an unresolved import into a **top-level** `throw` in the chunk,
 * so an optional dependency nobody uses takes down whatever loaded it the moment
 * it loads — surfacing as `DRIVER_CRASHED` on the first connection, with a stack
 * pointing at minified vendor code. Each stub loads cleanly and only complains
 * if the feature is actually used.
 *
 * ## Why it is a module of its own
 *
 * Two builds inline the same clients from two different Rollup graphs:
 * `electron.vite.config.ts` builds `out/main/driver-host.js`, and
 * `scripts/build-packages.mjs` builds each package's `driver.mjs`. Both must
 * answer "what is `pg-native` here" identically — a stub in one and an
 * unresolved import in the other is not a smaller version of the same bug, it is
 * a build that is green in the repository and dead in the packaged app. Same
 * argument as `main-may-reach.ts`, which two boundary checks read for the same
 * reason.
 *
 * ## Why a function rather than a constant
 *
 * The stubs live under `src/main/driver-host/`, so the table has to be resolved
 * against the desktop package root — and the two callers reach that root
 * differently (a Vite config gets `__dirname`; a script in `scripts/` walks up
 * from `import.meta.dirname`). Taking it as an argument keeps this module free of
 * both spellings, which is what lets it be loaded by the config bundler and by
 * plain node alike.
 *
 * There is no stub for a *native* module here, and there is none anywhere:
 * design 2026-08-07 §1.2 checked, and all three of these are pure-JS opt-ins.
 * That is the technical precondition for a package's `driver.mjs` being one
 * self-contained file, so the day a real `.node` binary appears in this table is
 * the day that stops being true.
 */
export function optionalDepAliasFrom(desktopDir: string): Record<string, string> {
  return {
    'pg-native': resolve(desktopDir, 'src/main/driver-host/pg-native-stub.ts'),
    '@opentelemetry/api': resolve(desktopDir, 'src/main/driver-host/opentelemetry-api-stub.ts'),
    '@node-rs/xxhash': resolve(desktopDir, 'src/main/driver-host/node-rs-xxhash-stub.ts'),
  }
}
