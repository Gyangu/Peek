import {
  defineManifest,
  definedField,
  formReaders,
  readFormText,
  urlField,
  type Capability,
  type ConnectFormSpec,
  type MysqlConnectionConfig,
  type SqliteConnectionConfig,
} from '@peek/core'

/**
 * What MySQL and SQLite *are*, for the parts of peek that run before a
 * connection does.
 *
 * Two manifests in one file, mirroring `driver.ts`: two driver ids, two connect
 * forms, one implementation behind both. Which databases this package ships is
 * this package's business, so the app spreads `sqlManifests` rather than naming
 * the two — same reason `driver-host/entry.ts` spreads `sqlDrivers`.
 *
 * Reached as `@peek/driver-sql/manifest`, a subpath that bypasses `index.ts` so
 * that importing it from the renderer or from main cannot pull `mysql2` into
 * either chunk. Allowed imports: `@peek/core` and `zod`. See the note in
 * `driver-postgres/src/manifest.ts`; `manifest-purity.test.ts` enforces it.
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
      { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
      { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '3306', required: true },
      { name: 'database', type: 'text', labelKey: 'connect.field.database', required: true, mono: true },
      { name: 'user', type: 'text', labelKey: 'connect.field.user', defaultValue: 'root', mono: true },
      { name: 'password', type: 'password', labelKey: 'connect.field.password' },
      { name: 'ssl', type: 'checkbox', labelKey: 'connect.field.ssl' },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const mysqlManifest = defineManifest({
  driverId: 'mysql',
  displayName: 'MySQL',
  version: PACKAGE_VERSION,
  capabilities: SQL_CAPABILITIES,
  connectForm: MYSQL_FORM,
  sqlDialect: 'mysql',
  mcpConnectExample: '{"driverId":"mysql","url":"mysql://user@host:3306/db"}',

  assembleConfig(mode, values, label) {
    const { text, num, bool } = formReaders(MYSQL_FORM.fields[mode], values)
    return {
      driverId: 'mysql',
      ...(label ? { label } : {}),
      ...definedField('url', text('url')),
      ...definedField('host', text('host')),
      ...definedField('port', num('port')),
      ...definedField('database', text('database')),
      ...definedField('user', text('user')),
      ...definedField('password', text('password')),
      ...definedField('ssl', bool('ssl')),
    }
  },

  endpointSummary(config: MysqlConnectionConfig) {
    if (config.url) return config.url
    return `${config.host ?? 'localhost'}:${config.port ?? 3306}/${config.database ?? ''}`
  },
})

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
        labelKey: 'connect.field.file',
        placeholder: '/absolute/path/to/db.sqlite',
        required: true,
        mono: true,
      },
      { name: 'readOnly', type: 'checkbox', labelKey: 'connect.field.readOnly', defaultValue: true },
    ],
  },
} as const satisfies ConnectFormSpec

export const sqliteManifest = defineManifest({
  driverId: 'sqlite',
  displayName: 'SQLite',
  version: PACKAGE_VERSION,
  capabilities: SQL_CAPABILITIES,
  connectForm: SQLITE_FORM,
  sqlDialect: 'sqlite',
  mcpConnectExample: '{"driverId":"sqlite","file":"/absolute/path/to/db.sqlite"}',

  assembleConfig(_mode, values, label) {
    return {
      driverId: 'sqlite',
      ...(label ? { label } : {}),
      file: readFormText(values, 'file'),
      // Explicitly false rather than omitted: the driver's own default is
      // read-only, but "I unticked the box" has to survive the trip.
      readOnly: values['readOnly'] !== false,
    }
  },

  endpointSummary(config: SqliteConnectionConfig) {
    return config.file
  },
})

/** Both manifests of this package, in the order the driver picker should list them */
export const sqlManifests = [mysqlManifest, sqliteManifest] as const
