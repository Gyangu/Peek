import {
  defineManifest,
  definedField,
  formReaders,
  urlField,
  type ConnectFormSpec,
  type RedisConnectionConfig,
} from '@peek/core'

/**
 * What Redis *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/driver-redis/manifest`, a subpath that bypasses `index.ts`
 * so that importing it from the renderer or from main cannot pull the `redis`
 * client (and its `@opentelemetry/api` / `@node-rs/xxhash` stubs) into either
 * chunk. Allowed imports: `@peek/core` and `zod`. See the note in
 * `driver-postgres/src/manifest.ts`; `manifest-purity.test.ts` enforces it.
 */

const CONNECT_FORM = {
  // Fields first: a redis connection is usually localhost plus a database index,
  // and the index is the one part a URL cannot carry naturally.
  modes: ['fields', 'url'],
  fields: {
    url: [urlField('redis://localhost:6379/0')],
    fields: [
      { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
      { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '6379', required: true },
      // The logical database index, which redis keeps outside the connection's
      // identity: it is selected per client, not carried in the URL host part.
      { name: 'db', type: 'number', labelKey: 'connect.field.db', defaultValue: '0' },
      { name: 'username', type: 'text', labelKey: 'connect.field.username', mono: true },
      { name: 'password', type: 'password', labelKey: 'connect.field.password' },
      { name: 'tls', type: 'checkbox', labelKey: 'connect.field.tls' },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const redisManifest = defineManifest({
  driverId: 'redis',
  displayName: 'Redis',
  version: PACKAGE_VERSION,
  capabilities: ['introspect', 'collectionScan', 'keyValue', 'valuePeek', 'cancel'],
  connectForm: CONNECT_FORM,
  mcpConnectExample: '{"driverId":"redis","url":"redis://localhost:6379/0"}',

  assembleConfig(mode, values, label) {
    const { text, num, bool } = formReaders(CONNECT_FORM.fields[mode], values)
    return {
      driverId: 'redis',
      ...(label ? { label } : {}),
      ...definedField('url', text('url')),
      ...definedField('host', text('host')),
      ...definedField('port', num('port')),
      ...definedField('db', num('db')),
      ...definedField('username', text('username')),
      ...definedField('password', text('password')),
      ...definedField('tls', bool('tls')),
    }
  },

  endpointSummary(config: RedisConnectionConfig) {
    return config.url ?? `${config.host ?? 'localhost'}:${config.port ?? 6379}/${config.db ?? 0}`
  },
})
