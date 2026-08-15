import { urlField, type Capability, type ConnectFormSpec, type DriverManifest } from '@peek/core'

/**
 * What MySQL and SQLite *are*, for the parts of peek that run before a
 * connection does.
 *
 * Two manifests in one file, mirroring `driver.ts`: two driver ids, two connect
 * forms, one implementation behind both. Which databases this package ships is
 * this package's business, so the app spreads `sqlManifests` rather than naming
 * the two — same reason `driver-host/entry.ts` spreads `sqlDrivers`.
 *
 * Reached as `@peek/db-sql/manifest`, a subpath that bypasses `index.ts` so
 * that importing it from the renderer or from main cannot pull `mysql2` into
 * either chunk. Allowed imports: `@peek/core` and `zod`. See the note in
 * `db-postgres/src/manifest.ts`; `manifest-purity.test.ts` enforces it.
 *
 * Two things this file used to hold and no longer does. `assembleConfig` said
 * "put the field named x into the config key named x" and nothing else — twice
 * in this file alone — so it was never configuration; it is the convention
 * `assembleFromForm` implements once, and `connectForm` below is its whole
 * input. `endpointSummary` moved next door to `display.ts`, joining the two
 * strings that were living in core: what a connection is *called* is the one
 * part of a package's description that has to stay code, and `DriverDisplay`'s
 * header is where that line gets drawn.
 */

/**
 * Identical for both, and identical to postgres — the three relational drivers
 * genuinely do the same five things. Named once here so that a change to what a
 * SQL driver can do is a change to one array.
 */
const SQL_CAPABILITIES: readonly Capability[] = [
  'introspect',
  'tabularQuery',
  'collectionScan',
  'valuePeek',
  'cancel',
]

/* ------------------------------------------------------------------ */
/* MySQL                                                               */
/* ------------------------------------------------------------------ */

const MYSQL_FORM = {
  modes: ['url', 'fields'],
  fields: {
    url: [urlField('mysql://user:password@localhost:3306/database')],
    fields: [
      {
        name: 'host',
        type: 'text',
        label: { en: 'Host', 'zh-CN': '主机' },
        defaultValue: 'localhost',
        required: true,
        mono: true,
      },
      {
        name: 'port',
        type: 'number',
        label: { en: 'Port', 'zh-CN': '端口' },
        defaultValue: '3306',
        required: true,
      },
      {
        name: 'database',
        type: 'text',
        label: { en: 'Database', 'zh-CN': '数据库' },
        required: true,
        mono: true,
      },
      {
        name: 'user',
        type: 'text',
        label: { en: 'User', 'zh-CN': '用户名' },
        defaultValue: 'root',
        mono: true,
      },
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

export const mysqlManifest: DriverManifest = {
  driverId: 'mysql',
  displayName: 'MySQL',
  version: PACKAGE_VERSION,
  capabilities: SQL_CAPABILITIES,
  connectForm: MYSQL_FORM,
  sqlDialect: 'mysql',
  /**
   * Two entries for one secret, because MySQL takes the password twice: its own
   * field, and the userinfo of a connection URL. Declaring only `password` would
   * leave a url-mode connection broadcasting `mysql://root:hunter2@…` verbatim,
   * which is the shape this config is most often written in.
   */
  redact: { password: 'value', url: 'url-password' },
  /**
   * Order is load-bearing, not stylistic: `connectionIdentity` joins these in
   * sequence, and the result is the key a saved credential is filed under —
   * reordering the list re-keys every stored MySQL password and orphans the lot.
   *
   * `user` is in and `password` is out on purpose. Identity has to name the
   * *account* so that two logins on one database stay two connections; it must
   * not contain the secret, or a config that came back out of the connection
   * book (which has no password by construction) would no longer match the entry
   * it came from.
   */
  identity: ['url', 'host', 'port', 'database', 'user'],
  mcpConnectExample: '{"driverId":"mysql","url":"mysql://user@host:3306/db"}',
  skill:
    'MySQL has no schema level between the database and the table, so the namespace tree is one ' +
    'shallower than PostgreSQL and a ref names the database and the table. Statements run inside ' +
    'a READ ONLY transaction: writes, SET and temporary tables all come back as CONFLICT, and no ' +
    'rephrasing gets them through. Do not add a LIMIT for safety — peek streams the result and ' +
    'the window pages it, so an unbounded SELECT costs the user nothing while a truncated one ' +
    'hides the rows they were looking for.',
}

/* ------------------------------------------------------------------ */
/* SQLite                                                              */
/* ------------------------------------------------------------------ */

/**
 * No URL mode: a file path is not a URL, and `sqlite:///x` would be a spelling
 * peek invented. `readOnly` defaults on — this is a viewer, and the driver
 * refuses to create a database that is not there.
 */
const SQLITE_FORM = {
  modes: ['fields'],
  fields: {
    url: [],
    fields: [
      {
        name: 'file',
        type: 'text',
        label: { en: 'Database file', 'zh-CN': '数据库文件' },
        placeholder: '/absolute/path/to/db.sqlite',
        required: true,
        mono: true,
        // Written even when empty: `file` is the whole config, and an omitted key
        // is refused by the schema as a missing property rather than as the empty
        // path the user actually left behind.
        always: true,
      },
      {
        name: 'readOnly',
        type: 'checkbox',
        label: { en: 'Open read-only', 'zh-CN': '只读打开' },
        defaultValue: true,
        // A ticked-by-default box, so "I unticked it" has to survive the trip: an
        // omitted `false` would be re-defaulted to read-only by the driver, and
        // the user would be told their unticking did nothing only by the file
        // staying unwritable.
        always: true,
      },
    ],
  },
} as const satisfies ConnectFormSpec

export const sqliteManifest: DriverManifest = {
  driverId: 'sqlite',
  displayName: 'SQLite',
  version: PACKAGE_VERSION,
  capabilities: SQL_CAPABILITIES,
  connectForm: SQLITE_FORM,
  sqlDialect: 'sqlite',
  /**
   * Empty, and that is the honest answer rather than an omission: this config is
   * a path and a boolean, and there is no credential anywhere in it — SQLite
   * authenticates by the filesystem. See `redactConnectionConfig` for what an
   * empty block costs a driver that *does* have a secret.
   */
  redact: {},
  /**
   * The file is the database. There is no server and no account to tell two
   * connections on one path apart, so the path alone decides.
   *
   * `readOnly` is deliberately out: the same file opened writable is the same
   * database, not a second one, and putting it in would file a credential — and
   * split a sidebar row — on a checkbox.
   */
  identity: ['file'],
  mcpConnectExample: '{"driverId":"sqlite","file":"/absolute/path/to/db.sqlite"}',
  skill:
    'Connect with file, an absolute path on this machine, not a URL. The database is opened ' +
    'read-only and with PRAGMA query_only, so SQLite itself refuses every write, including ' +
    'ATTACH and the PRAGMA statements that would change it. The namespace tree is the main ' +
    'database plus whatever was attached when it was opened. Do not add a LIMIT for safety: ' +
    'peek streams the result and pages it in the window.',
}

/** Both manifests of this package, in the order the driver picker should list them */
export const sqlManifests = [mysqlManifest, sqliteManifest] as const
