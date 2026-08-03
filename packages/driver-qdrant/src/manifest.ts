import {
  defineManifest,
  definedField,
  formReaders,
  readFormText,
  type ConnectFormSpec,
  type QdrantConnectionConfig,
} from '@peek/core'

/**
 * What Qdrant *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/driver-qdrant/manifest`, a subpath that bypasses `index.ts`
 * so that importing it from the renderer or from main cannot pull
 * `@qdrant/js-client-rest` into either chunk. Allowed imports: `@peek/core` and
 * `zod`. See the note in `driver-postgres/src/manifest.ts`;
 * `manifest-purity.test.ts` enforces it.
 */

/**
 * One mode, and `url` is an ordinary field inside it rather than a mode of its
 * own. Qdrant has no host/port/database triple to offer as an alternative — a
 * base URL *is* how the server is named — so a mode picker would present one
 * real choice and one empty form.
 */
const CONNECT_FORM = {
  modes: ['fields'],
  fields: {
    url: [],
    fields: [
      {
        name: 'url',
        type: 'text',
        labelKey: 'connect.field.qdrantUrl',
        placeholder: 'http://localhost:6333',
        defaultValue: 'http://localhost:6333',
        required: true,
        mono: true,
      },
      { name: 'apiKey', type: 'password', labelKey: 'connect.field.apiKey' },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const qdrantManifest = defineManifest({
  driverId: 'qdrant',
  displayName: 'Qdrant',
  version: PACKAGE_VERSION,
  // No `cancel`: qdrant's REST client has no server-side cancellation, which is
  // why the deadline escalation in ConnectionManager exists.
  capabilities: ['introspect', 'collectionScan', 'vectorSearch', 'valuePeek'],
  connectForm: CONNECT_FORM,
  mcpConnectExample: '{"driverId":"qdrant","url":"http://localhost:6333"}',

  assembleConfig(mode, values, label) {
    const { text } = formReaders(CONNECT_FORM.fields[mode], values)
    return {
      driverId: 'qdrant',
      ...(label ? { label } : {}),
      // Read unconditionally rather than through `text`: `url` is required, so an
      // empty one must reach the schema and be refused by name, not vanish into
      // an omitted field and be refused as "url: required".
      url: readFormText(values, 'url'),
      ...definedField('apiKey', text('apiKey')),
    }
  },

  endpointSummary(config: QdrantConnectionConfig) {
    return config.url
  },
})
