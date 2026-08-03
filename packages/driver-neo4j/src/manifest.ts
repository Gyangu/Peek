import {
  defineManifest,
  definedField,
  formReaders,
  type ConnectFormSpec,
  type Neo4jConnectionConfig,
} from '@peek/core'

/**
 * What Neo4j *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/driver-neo4j/manifest`, a subpath that bypasses `index.ts` so
 * that importing it from the renderer or from main cannot pull `neo4j-driver`
 * into either chunk. Allowed imports: `@peek/core` and `zod`.
 * `manifest-purity.test.ts` enforces it.
 */

/**
 * Two modes, because the two ways of naming a Neo4j server are genuinely
 * different and not two spellings of one thing.
 *
 * `bolt://` pins a single server; `neo4j://` asks the cluster for its routing
 * table and may end up somewhere else entirely. Assembling a URL from a host and
 * a port would mean *peek* choosing between those for the user, silently. The
 * fields mode still exists for the single-instance case, where it spells
 * `bolt://` and says so in the placeholder.
 */
const CONNECT_FORM = {
  modes: ['url', 'fields'],
  fields: {
    url: [
      {
        name: 'url',
        type: 'text',
        labelKey: 'connect.field.url',
        placeholder: 'neo4j://localhost:7687',
        defaultValue: 'neo4j://localhost:7687',
        required: true,
        mono: true,
      },
      { name: 'user', type: 'text', labelKey: 'connect.field.user', defaultValue: 'neo4j' },
      { name: 'password', type: 'password', labelKey: 'connect.field.password' },
      {
        name: 'database',
        type: 'text',
        labelKey: 'connect.field.database',
        placeholder: 'neo4j',
        mono: true,
      },
    ],
    fields: [
      { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', mono: true },
      { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '7687' },
      { name: 'user', type: 'text', labelKey: 'connect.field.user', defaultValue: 'neo4j' },
      { name: 'password', type: 'password', labelKey: 'connect.field.password' },
      {
        name: 'database',
        type: 'text',
        labelKey: 'connect.field.database',
        placeholder: 'neo4j',
        mono: true,
      },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const neo4jManifest = defineManifest({
  driverId: 'neo4j',
  displayName: 'Neo4j',
  version: PACKAGE_VERSION,
  /**
   * `tabularQuery` is Cypher. It is not SQL and the editor is told so by the
   * absence of `sqlDialect` — a `RETURN` highlighted as if it were a `SELECT` is
   * worse than no highlighting, because it implies a grammar that will not parse.
   *
   * `cancel` is here and honoured: Bolt has a real server-side reset, so unlike
   * the qdrant driver this one can stop a running query rather than only stop
   * reading it.
   */
  capabilities: ['introspect', 'tabularQuery', 'collectionScan', 'valuePeek', 'cancel'],
  connectForm: CONNECT_FORM,
  mcpConnectExample: '{"driverId":"neo4j","url":"neo4j://localhost:7687","user":"neo4j"}',

  assembleConfig(mode, values, label) {
    const { text, num } = formReaders(CONNECT_FORM.fields[mode], values)
    return {
      driverId: 'neo4j',
      ...(label ? { label } : {}),
      ...definedField('url', text('url')),
      ...definedField('host', text('host')),
      ...definedField('port', num('port')),
      ...definedField('user', text('user')),
      ...definedField('password', text('password')),
      ...definedField('database', text('database')),
    }
  },

  endpointSummary(config: Neo4jConnectionConfig) {
    const at = config.url ?? `bolt://${config.host ?? 'localhost'}:${String(config.port ?? 7687)}`
    return config.database === undefined ? at : `${at}/${config.database}`
  },
})
