/**
 * Builds a stand-in for an optional npm dependency we deliberately do not ship.
 *
 * The bundled database clients reference packages they only need behind a
 * feature flag (`pg-native`, `@opentelemetry/api`, `@node-rs/xxhash`). None are
 * installed, and Vite compiles an unresolved import into a **top-level** `throw`
 * in the emitted chunk — so a feature nobody uses takes down driver-host on
 * load rather than degrading. Aliasing the specifier at a stub (see
 * `optionalDepAlias` in electron.vite.config.ts) is what keeps the module
 * loadable.
 *
 * A Proxy rather than an empty object: the client libraries reach these behind
 * their own try/catch, and a throwing property access lands in that catch as
 * the library's own "package not found" error. An empty object would instead
 * slip through and fail later as `undefined is not a function`.
 */
export function optionalDepStub(packageName: string, hint: string): object {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `${packageName} is not bundled with peek (accessed "${String(prop)}"). ${hint}`,
        )
      },
    },
  )
}
