import { type ConnectFormSpec, type DriverManifest } from '@peek/core'

/**
 * What Qdrant *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/db-qdrant/manifest`, a subpath that bypasses `index.ts`
 * so that importing it from the renderer or from main cannot pull
 * `@qdrant/js-client-rest` into either chunk. Allowed imports: `@peek/core` and
 * `zod`. See the note in `db-postgres/src/manifest.ts`;
 * `manifest-purity.test.ts` enforces it.
 *
 * Pure data now, no methods. `assembleConfig` is gone — a field's `name` is the
 * config key it fills, and core's `assembleFromForm` applies that convention for
 * every package — and `endpointSummary` moved to `./display` alongside the two
 * strings that name a connection in the sidebar. That file is bound by this same
 * import rule for the same reason, even though the purity scan does not read it
 * yet.
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
        label: { en: 'Server address', 'zh-CN': '服务地址' },
        placeholder: 'http://localhost:6333',
        defaultValue: 'http://localhost:6333',
        required: true,
        mono: true,
        // Written even when the box is empty: `url` is the one required field, so
        // an empty one must reach the schema and be refused *by name* rather than
        // vanish into an omitted key and be refused as "url: required".
        always: true,
      },
      { name: 'apiKey', type: 'password', label: { en: 'API key', 'zh-CN': 'API Key' } },
    ],
  },
} as const satisfies ConnectFormSpec

/**
 * This package's version, kept identical to its `package.json` by
 * `manifest-versions.test.ts` — see `DriverManifest.version` for why it is
 * stated here rather than read.
 */
const PACKAGE_VERSION = '0.0.1'

export const qdrantManifest: DriverManifest = {
  driverId: 'qdrant',
  displayName: 'Qdrant',
  version: PACKAGE_VERSION,
  // No `cancel`: qdrant's REST client has no server-side cancellation, which is
  // why the deadline escalation in ConnectionManager exists.
  capabilities: ['introspect', 'collectionScan', 'vectorSearch', 'valuePeek'],
  connectForm: CONNECT_FORM,
  // The API key is a bearer token in its entirety, so there is no partial form of
  // it worth keeping; the URL keeps everything but the password, because the
  // address is what makes the connection recognisable.
  //
  // **`url` is a behaviour change, not part of the move.** The switch this
  // replaces listed only the API key — the key travels as its own client option
  // and becomes an `api-key` header (`session.ts`), so the base URL reads as an
  // address — and a URL pasted in with userinfo therefore went into MCP receipts,
  // the renderer broadcast and the command log verbatim. The rest of the repo
  // already disagreed: `config/connection-book.ts` strips the password out of a
  // qdrant URL before writing the file, and `store/sanitize.ts` counts `url`
  // among its secret fields. Turning "what is secret" into a declaration is what
  // made this the one table left saying otherwise, so it is corrected here rather
  // than carried over faithfully.
  redact: { apiKey: 'value', url: 'url-password' },
  // One field, because one field is the whole address: qdrant has no database or
  // account to open underneath it, and the API key names a permission rather than
  // an identity. The URL's password-free form is what actually gets compared —
  // `connectionIdentity` does that, and the `driverId` prefix, for every driver.
  identity: ['url'],
  mcpConnectExample: '{"driverId":"qdrant","url":"http://localhost:6333"}',
  skill:
    'Two ways in, both scoped to one collection: opening a collection scans its points in id ' +
    'order, and a vector view searches it by similarity. There is no cross-collection query and ' +
    'no query language. Cancelling does not work here — Qdrant is the one driver without the ' +
    'cancel capability, so cancel_query stops peek reading while the server keeps computing. ' +
    'Choose a smaller limit rather than starting something large and changing your mind. ' +
    'Sorting a scan needs a payload index on that field; without one the server refuses instead ' +
    'of sorting slowly, which is why a scan may report fewer affordances than a SQL table.',
}
