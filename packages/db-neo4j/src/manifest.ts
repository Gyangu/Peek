import { type ConnectFormSpec, type DriverManifest, type PackageViewKind } from '@peek/core'

/**
 * What Neo4j *is*, for the parts of peek that run before a connection does.
 *
 * Reached as `@peek/db-neo4j/manifest`, a subpath that bypasses `index.ts` so
 * that importing it from the renderer or from main cannot pull `neo4j-driver`
 * into either chunk. Allowed imports: `@peek/core` and `zod`.
 * `manifest-purity.test.ts` enforces it.
 *
 * Pure data now, no methods. `assembleConfig` is gone — every field here filled
 * the config key of its own name and nothing else, so the mapping was a
 * convention each package happened to retype rather than something a package
 * configured; core's `assembleFromForm` applies it once for all of them.
 * `endpointSummary` moved to `./display`, next to the two strings that name a
 * connection in the sidebar, because those three were always one job split
 * across two files. That file is bound by this same import rule for the same
 * reason, even though the purity scan does not read it yet.
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
        label: { en: 'Connection string', 'zh-CN': '连接串' },
        placeholder: 'neo4j://localhost:7687',
        defaultValue: 'neo4j://localhost:7687',
        required: true,
        mono: true,
      },
      { name: 'user', type: 'text', label: { en: 'User', 'zh-CN': '用户名' }, defaultValue: 'neo4j' },
      { name: 'password', type: 'password', label: { en: 'Password', 'zh-CN': '密码' } },
      {
        name: 'database',
        type: 'text',
        label: { en: 'Database', 'zh-CN': '数据库' },
        placeholder: 'neo4j',
        mono: true,
      },
    ],
    fields: [
      {
        name: 'host',
        type: 'text',
        label: { en: 'Host', 'zh-CN': '主机' },
        defaultValue: 'localhost',
        mono: true,
      },
      { name: 'port', type: 'number', label: { en: 'Port', 'zh-CN': '端口' }, defaultValue: '7687' },
      { name: 'user', type: 'text', label: { en: 'User', 'zh-CN': '用户名' }, defaultValue: 'neo4j' },
      { name: 'password', type: 'password', label: { en: 'Password', 'zh-CN': '密码' } },
      {
        name: 'database',
        type: 'text',
        label: { en: 'Database', 'zh-CN': '数据库' },
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

export const neo4jManifest: DriverManifest = {
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
  /**
   * Both fields, because Neo4j takes the password in either place: `password` is
   * a field of its own *and* Bolt accepts it inside the URL's userinfo, exactly
   * the two-field shape postgres has. Scrubbing one and not the other would put
   * the credential in every MCP receipt anyway, which is why the old `switch`
   * arm did both and this replaces it line for line.
   */
  redact: { password: 'value', url: 'url-password' },
  /**
   * `database` is the entry worth defending. Neo4j is multi-database and a Bolt
   * session is *not* pinned to one, so two connections to the same server that
   * open different databases are two connections — and identity is what a stored
   * credential is released against, so collapsing them would hand one
   * connection's password to the other.
   *
   * The order is the order `connectionIdentity` joins, so reordering this list
   * re-keys every saved credential.
   */
  identity: ['url', 'host', 'port', 'database', 'user'],
  mcpConnectExample: '{"driverId":"neo4j","url":"neo4j://localhost:7687","user":"neo4j"}',
  skill:
    'The query language is Cypher, not SQL, and run_query takes it directly. Every session is ' +
    'opened with READ access at the server, so a write is refused by Neo4j itself and arrives ' +
    'as CONFLICT — nothing inspects the statement text, so there is no phrasing that gets one ' +
    'through. The namespace tree has two groups rather than one: node labels and relationship ' +
    'types. Neo4j also contributes a graph view: open_view with ' +
    '{"kind":"package","packageKind":"graph","connId":"..."} draws a node-link diagram, ' +
    'read_workspace reports it as kind "graph", and expand_node re-centres it on one node by ' +
    'elementId(). It holds at most 500 nodes, because a force-directed layout stops being ' +
    'readable well before that.',
}

/**
 * The `graph` view kind, minus the four functions that draw and feed it.
 *
 * Here rather than beside them in `./view` because this is the half that has to
 * be readable **without running anything**: `build-packages.mjs` serializes it
 * into `peek-package.json`, and main answers "which views can this connection
 * open" off that file, with no package host forked (§2.4bis(d)). `./view` builds
 * its registration from these two fields rather than restating them, so the two
 * halves cannot drift into naming different kinds.
 *
 * `title` is the kind's own name, carried rather than named by a message key,
 * for the reason `label` is: `view.kind.graph` is an entry in the *renderer's*
 * catalog, and a package installed from outside this repository cannot put one
 * there. The strings are the ones that catalog holds today.
 */
export const graphViewKindMeta: PackageViewKind = {
  kind: 'graph',
  driverIds: ['neo4j'],
  title: { en: 'Graph', 'zh-CN': '关系图' },
}
