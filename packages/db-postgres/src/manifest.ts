import { urlField, type ConnectFormSpec, type DriverManifest } from '@peek/core'

/**
 * What PostgreSQL *is*, for the parts of peek that run before a connection does.
 *
 * **Data, and only data.** The two functions that used to live here —
 * `assembleConfig` and `endpointSummary` — are gone in opposite directions:
 * assembling a config turned out to be a convention every package re-typed
 * identically (`assembleFromForm` in core), and the three strings that *name* a
 * connection are code, in `./display`. What is left has to survive being written
 * as JSON, because that is where a package is headed
 * (`docs/design/2026-08-07-database-packages-from-disk.md`).
 *
 * ## This file may not import a database client
 *
 * It is reached as `@peek/db-postgres/manifest`, a subpath that deliberately
 * bypasses `index.ts` — because `index.ts` pulls in `./driver` and `./driver`
 * pulls in `pg`. The renderer and the main process both import this module; if
 * it ever reaches `pg`, `pg-native`'s stub and some 700 kB of client come with
 * it into the window's chunk, and nothing fails loudly to say so.
 *
 * Allowed imports: `@peek/core` and `zod`, both of which the renderer already
 * carries. `manifest-purity.test.ts` enforces it.
 */

/**
 * A field's `name` is the config key it fills — that convention *is* what
 * replaced `assembleConfig`, so this table is now the only statement of how a
 * filled-in form becomes a `PostgresConnectionConfig`. Renaming a field here
 * renames a config key, silently and at a distance; see `assembleFromForm`.
 *
 * Nothing carries `always`: every one of these keys is optional in
 * `PostgresConnectionConfigSchema`, and for an optional key "the box was empty"
 * and "the key is absent" are the same statement. `url` is the one where it
 * matters — `session.ts` tests it with `!== undefined`, so an `url: ''` that
 * survived the assembly would reach `pg` as `connectionString: ''` and override
 * the host and port it was supposed to be an alternative to.
 */
const CONNECT_FORM = {
  modes: ['url', 'fields'],
  fields: {
    url: [urlField('postgresql://user@localhost:5432/database')],
    fields: [
      { name: 'host', type: 'text', label: { en: 'Host', 'zh-CN': '主机' }, defaultValue: 'localhost', required: true, mono: true },
      { name: 'port', type: 'number', label: { en: 'Port', 'zh-CN': '端口' }, defaultValue: '5432', required: true },
      { name: 'database', type: 'text', label: { en: 'Database', 'zh-CN': '数据库' }, required: true, mono: true },
      { name: 'user', type: 'text', label: { en: 'User', 'zh-CN': '用户名' }, mono: true },
      { name: 'password', type: 'password', label: { en: 'Password', 'zh-CN': '密码' } },
      { name: 'ssl', type: 'checkbox', label: { en: 'Use TLS', 'zh-CN': '使用 TLS' } },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const postgresManifest: DriverManifest = {
  driverId: 'postgres',
  displayName: 'PostgreSQL',
  version: PACKAGE_VERSION,
  capabilities: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  connectForm: CONNECT_FORM,
  sqlDialect: 'postgres',

  /**
   * Both, because PostgreSQL takes the password twice over: as its own field and
   * inside the URL's userinfo, either of which alone is a working credential.
   * Scrubbing one and not the other reads as redacted while still shipping the
   * secret — the failure mode that has no symptom.
   *
   * `user` is deliberately not here. It names an account rather than proving
   * anything, and blanking it would make two connections that differ only by
   * role indistinguishable everywhere a redacted config is shown.
   */
  redact: { password: 'value', url: 'url-password' },

  /**
   * Server, database, account — the five fields that decide whether two configs
   * are the same connection, in the order the old `connectionIdentity` switch
   * joined them. **Order is part of the string**, so reordering this list
   * re-keys every stored credential; treat it as append-only.
   *
   * `ssl`, `applicationName`, `connectTimeoutMs` and `searchPath` are absent
   * because they change how peek talks to a server, not which server it is —
   * flipping `ssl` must not lose the saved password. `password` is absent for
   * the stronger reason: identity is what a stored credential is released
   * *against*, so putting the credential in it would mean you need the password
   * to look up the password.
   */
  identity: ['url', 'host', 'port', 'database', 'user'],

  mcpConnectExample: '{"driverId":"postgres","url":"postgresql://user@host:5432/db"}',
  skill:
    'The namespace tree is database, then schema, then table or view, so a ref always names ' +
    'the schema as well as the table; a bare table name in a statement resolves by search_path ' +
    'and may not be the one you introspected. Statements run inside a READ ONLY transaction, ' +
    'which refuses writes but also refuses SET, temporary tables and CREATE EXTENSION — those ' +
    'come back as CONFLICT and no rephrasing gets them through. Do not add a LIMIT for safety: ' +
    'peek streams the result and the window pages it, so an unbounded SELECT costs the user ' +
    'nothing while a truncated one hides the rows they were looking for.',
}
