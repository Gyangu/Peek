import {
  defineManifest,
  definedField,
  formReaders,
  urlField,
  type ConnectFormSpec,
  type PostgresConnectionConfig,
} from '@peek/core'

/**
 * What PostgreSQL *is*, for the parts of peek that run before a connection does.
 *
 * ## This file may not import a database client
 *
 * It is reached as `@peek/driver-postgres/manifest`, a subpath that deliberately
 * bypasses `index.ts` — because `index.ts` pulls in `./driver` and `./driver`
 * pulls in `pg`. The renderer and the main process both import this module; if
 * it ever reaches `pg`, `pg-native`'s stub and some 700 kB of client come with
 * it into the window's chunk, and nothing fails loudly to say so.
 *
 * Allowed imports: `@peek/core` and `zod`, both of which the renderer already
 * carries. `manifest-purity.test.ts` enforces it.
 */

const CONNECT_FORM = {
  modes: ['url', 'fields'],
  fields: {
    url: [urlField('postgresql://user@localhost:5432/database')],
    fields: [
      { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
      { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '5432', required: true },
      { name: 'database', type: 'text', labelKey: 'connect.field.database', required: true, mono: true },
      { name: 'user', type: 'text', labelKey: 'connect.field.user', mono: true },
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

export const postgresManifest = defineManifest({
  driverId: 'postgres',
  displayName: 'PostgreSQL',
  version: PACKAGE_VERSION,
  capabilities: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  connectForm: CONNECT_FORM,
  sqlDialect: 'postgres',
  mcpConnectExample: '{"driverId":"postgres","url":"postgresql://user@host:5432/db"}',
  skill:
    'The namespace tree is database, then schema, then table or view, so a ref always names ' +
    'the schema as well as the table; a bare table name in a statement resolves by search_path ' +
    'and may not be the one you introspected. Statements run inside a READ ONLY transaction, ' +
    'which refuses writes but also refuses SET, temporary tables and CREATE EXTENSION — those ' +
    'come back as CONFLICT and no rephrasing gets them through. Do not add a LIMIT for safety: ' +
    'peek streams the result and the window pages it, so an unbounded SELECT costs the user ' +
    'nothing while a truncated one hides the rows they were looking for.',

  assembleConfig(mode, values, label) {
    const { text, num, bool } = formReaders(CONNECT_FORM.fields[mode], values)
    return {
      driverId: 'postgres',
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

  endpointSummary(config: PostgresConnectionConfig) {
    if (config.url) return config.url
    return `${config.host ?? 'localhost'}:${config.port ?? 5432}/${config.database ?? ''}`
  },
})
