import { urlField, type ConnectFormSpec, type DriverManifest } from '@peek/core'

/**
 * What Redis *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/db-redis/manifest`, a subpath that bypasses `index.ts`
 * so that importing it from the renderer or from main cannot pull the `redis`
 * client (and its `@opentelemetry/api` / `@node-rs/xxhash` stubs) into either
 * chunk. Allowed imports: `@peek/core` and `zod`. See the note in
 * `db-postgres/src/manifest.ts`; `manifest-purity.test.ts` enforces it.
 *
 * Pure data, and nothing else — see `DriverManifest`'s header for why that has
 * to stay true. The three strings that *name* a redis connection live next door
 * in `./display`, which is code and runs in the package host.
 */

const CONNECT_FORM = {
  // Fields first: a redis connection is usually localhost plus a database index,
  // and the index is the one part a URL cannot carry naturally.
  modes: ['fields', 'url'],
  fields: {
    url: [urlField('redis://localhost:6379/0')],
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
        defaultValue: '6379',
        required: true,
      },
      // The logical database index, which redis keeps outside the connection's
      // identity: it is selected per client, not carried in the URL host part.
      { name: 'db', type: 'number', label: { en: 'Database index', 'zh-CN': '库编号' }, defaultValue: '0' },
      { name: 'username', type: 'text', label: { en: 'User', 'zh-CN': '用户名' }, mono: true },
      { name: 'password', type: 'password', label: { en: 'Password', 'zh-CN': '密码' } },
      { name: 'tls', type: 'checkbox', label: { en: 'Use TLS', 'zh-CN': '使用 TLS' } },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const redisManifest: DriverManifest = {
  driverId: 'redis',
  displayName: 'Redis',
  version: PACKAGE_VERSION,
  capabilities: ['introspect', 'collectionScan', 'keyValue', 'valuePeek', 'cancel'],
  connectForm: CONNECT_FORM,

  // Two fields, because redis takes the password twice: as its own field and
  // inside the URL's userinfo. Blanking only the field would leave the URL
  // carrying the same secret in plain text through every snapshot it appears in.
  redact: { password: 'value', url: 'url-password' },

  // `username` is in here and `password` is not, which is the rule in one line:
  // identity names a server and an account, and the secret that *proves* the
  // account is not part of *which* account it is.
  //
  // `db` is in here even though the field comment above calls it "outside the
  // connection's identity" — that sentence is about redis, where the index is
  // selected per client rather than dialled. peek's identity is what a stored
  // credential gets released against, and two connections to one server that open
  // different logical databases must not be able to read each other's password.
  // `driverId` leads and the URL loses its password before joining; both of those
  // are the kernel's and cannot be declared away here.
  identity: ['url', 'host', 'port', 'db', 'username'],

  mcpConnectExample: '{"driverId":"redis","url":"redis://localhost:6379/0"}',
  skill:
    'There is no query language here. run_query is not supported on a Redis connection and ' +
    'answers UNSUPPORTED_CAPABILITY rather than an empty result — browse instead. introspect ' +
    'walks the keyspace as key patterns, and opening one scans it with SCAN rather than KEYS, ' +
    'so it is safe against a live server. A key is read through the key/value surface, which ' +
    'treats the Redis types as six different shapes rather than six renderings of one: what a ' +
    'hash, a list and a stream each support differs. The database number is part of the ' +
    'connection URL (redis://host:6379/0) and is not something to switch mid-session.',
}
