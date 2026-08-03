/**
 * Stub for `pg-native`, aliased in electron.vite.config.ts.
 *
 * `pg` carries an optional dependency on `pg-native` (a libpq-backed client).
 * We never use it — `pg.Client` is the pure-JS path — but the reference is a
 * plain `require('pg-native')` inside pg's source, so bundling pg drags the
 * specifier in. It is not installed, and Vite turns an unresolved import into a
 * **top-level** `throw` in the emitted chunk, which kills the whole driver-host
 * process the moment it loads: the connection surfaces as `DRIVER_CRASHED`
 * rather than as a missing optional dependency.
 *
 * The module must therefore load cleanly. pg only ever touches this binding
 * behind `NODE_PG_FORCE_NATIVE` or an explicit `pg.native` access, neither of
 * which this app does, so throwing on construction keeps the failure honest
 * while leaving the JS path untouched.
 */
export default class PgNativeUnavailable {
  constructor() {
    throw new Error(
      'pg-native is not bundled with peek. The PostgreSQL driver uses the pure-JS pg client; ' +
        'do not set NODE_PG_FORCE_NATIVE or access pg.native.',
    )
  }
}
