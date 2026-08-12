import {
  redactConnectionConfig,
  type ConnCloseResult,
  type ConnOpenResult,
  type ConnectionConfig,
  type ConnectionState,
} from '@peek/core'
import {
  connectFormOf,
  connectionIdentityOf,
  driverCapabilities,
  parseConnectionConfigOf,
  redactRulesFor,
} from '../../../drivers/manifests'
import { putConnection, removeConnection } from '../../store/mutations'
import { fail, failMsg } from '../failure'
import type { CommandHandlerMap } from '../types'
import { openView } from './shared'

/**
 * The pure state part of conn.*. Actually connecting and disconnecting are side
 * effects: this file only registers intents (ctx.plan), which effects.ts runs
 * through the injected ConnectionService.
 */
export const connHandlers = {
  'conn.open': {
    reduce(draft, input, ctx) {
      const connId = input.connId ?? ctx.ids.conn()
      const existing = draft.connections[connId]
      // Everything below reads `config` rather than `input.config`: the parse is
      // what makes the driver id one a package answers for, and the fields ones
      // that package declared. See `knownConfig`.
      const config = knownConfig(input.config)

      // The strings that name this connection are asked for **here and only
      // here** — this reducer is the one moment a config becomes a connection,
      // and a config never changes afterwards, so the answers never go stale.
      // Everything downstream (the snapshot, the sidebar, MCP) reads them;
      // nobody re-derives them. §2.3(b) of the packages-from-disk design is what
      // this implements, and the reason it is a reducer and not the connection
      // manager: the manager mirrors the source of truth, it does not write it.
      //
      // They are *asked for* rather than computed because the code that knows the
      // answers is the package's, and a package's code runs in its own host
      // process now (§2.4bis). A reduction is synchronous and stays that way —
      // that invariant is worth more than these three strings — so the split is
      // the one §2.3(b) prescribes: seed here, plan the round trip, patch the
      // answer in when it lands.
      //
      // The config handed over is the **redacted** one. A label falls back to the
      // url when there is no database or host, and detail *is* the url — since
      // both are broadcast to the renderer and to MCP, deriving them from the raw
      // config would ship the password along with them. It is also what leaves
      // main: the package host is the far side of this call.
      const shown = redactConnectionConfig(config, redactRulesFor(config.driverId))

      const conn: ConnectionState = {
        id: connId,
        driverId: config.driverId,
        // Computed from the config as it arrived, which is also what the
        // connection book keys its entry by — `connectionIdentity` strips a URL's
        // password itself, so the raw, the stripped and the redacted spelling of
        // one config all reduce to the same string. That agreement is what lets
        // the sidebar pair this connection with its saved entry.
        identity: connectionIdentityOf(config),
        // Seeded from whatever this connection was called a moment ago, and empty
        // only when there is no "a moment ago". Reopening is the common case —
        // the sidebar's saved rows and every reconnect land here with an existing
        // connId — and blanking a name that is about to be recomputed to the same
        // string would make the row flicker once per reconnect. The patch that
        // follows always overwrites, so a stale seed lives exactly one round trip.
        label: existing?.label ?? '',
        detail: existing?.detail ?? '',
        endpoint: existing?.endpoint ?? '',
        // The cleartext config lives only in main's source of truth; everything
        // leaving main goes through redaction (see store/sanitize.ts).
        config,
        status: 'connecting',
        // Predict capabilities from the driver until we are connected; the
        // driver host fills in the real set once the connection is ready.
        capabilities: existing?.capabilities ?? [...(driverCapabilities()[config.driverId] ?? [])],
        // Reopening overwrites it on purpose: whoever asked most recently is who
        // the next failure belongs to.
        origin: ctx.source,
      }
      putConnection(draft, conn)

      // Before `connect`, so the row is named while it is still saying
      // "connecting" rather than a beat after it goes green. It is planned on
      // every `conn.open` — a new connection, a reconnect, and a saved entry
      // reopened from the connection book all arrive through this one reducer,
      // and skipping it for the ones that already have a name is how a row gets
      // stuck showing what a config used to say.
      //
      // `soft`: a connection whose name did not arrive is still a usable
      // connection. Failing the command over it would report a broken database
      // because a package host was slow.
      ctx.plan({ type: 'describeConnection', connId, config: shown, soft: true })

      const timeoutMs = connectTimeoutOf(config)
      ctx.plan({
        type: 'connect',
        connId,
        config,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })

      const result: ConnOpenResult = {
        connId,
        status: 'connecting',
        capabilities: conn.capabilities,
      }
      if (input.openTree) {
        // Open the tree view right away; once connected the renderer fetches the
        // first level (introspect is not a Command).
        result.treeViewId = openView(draft, { kind: 'tree', connId }, ctx, {}).viewId
      }
      return result
    },

    // Connecting is asynchronous, so status / capabilities in the result come
    // from the source of truth after the effects have run.
    finalize(data, state) {
      const conn = state.connections[data.connId]
      if (!conn) return data
      return {
        ...data,
        status: conn.status,
        capabilities: conn.capabilities,
        ...(conn.serverInfo ? { serverInfo: conn.serverInfo } : {}),
      }
    },
  },

  'conn.close': {
    reduce(draft, input, ctx) {
      if (!draft.connections[input.connId]) {
        failMsg('NOT_FOUND', 'error.conn.notFound', { connId: input.connId })
      }

      const closeViews = input.closeViews !== false
      const { closedViewIds, abortedResultIds } = removeConnection(draft, input.connId, closeViews)

      // Closing a connection reclaims the driver host process, so any running
      // result set dies with it; these cancels are only a best-effort courtesy.
      for (const resultId of abortedResultIds) {
        ctx.plan({ type: 'cancel', connId: input.connId, resultId, soft: true })
      }
      ctx.plan({ type: 'disconnect', connId: input.connId, soft: true })

      const result: ConnCloseResult = { connId: input.connId, closedViewIds }
      return result
    },
  },
} satisfies CommandHandlerMap

/**
 * The config, measured against the fields its own package declared.
 *
 * **This is the gate the discriminated union used to be.** `conn.open`'s input
 * schema checks that `config` is a record with a servable `driverId` and stops
 * there, because core cannot look a package up — so an id no package provides,
 * or a `port` that is a string, would otherwise travel all the way to a driver
 * host. The three things below all assume it did not: `connectionIdentityOf`
 * throws for a driver with no manifest (deliberately — there is no safe guess at
 * which fields identify a connection), the reducer hands the config to that
 * package's host to be named, and the effect hands it to a driver process.
 *
 * A reducer refusing input reads oddly, and it is the right place regardless:
 * this is the one funnel every `conn.open` passes through — the dialog, an MCP
 * `connect`, and a saved entry reopened from the sidebar — and refusing here is
 * one structured `BAD_REQUEST` instead of a `TypeError` from wherever the shape
 * first mattered.
 */
function knownConfig(config: ConnectionConfig): ConnectionConfig {
  if (connectFormOf(config.driverId) === null) {
    failMsg('BAD_REQUEST', 'error.conn.driverNotRegistered', { driverId: config.driverId })
  }
  const parsed = parseConnectionConfigOf(config, 'keep')
  if (parsed.ok) return parsed.config
  // English, and not a catalog key: the connect dialog checks the same fields
  // before it sends anything (`validateConnectionConfig`), so whoever reaches
  // this is an MCP caller or a hand-edited `connections.json` — both surfaces
  // where the field name and the reason are the whole message.
  fail(
    'BAD_REQUEST',
    `That is not a config the ${config.driverId} driver accepts: ${parsed.issues.join('; ')}`,
  )
}

/** Not every driver offers a connect timeout, and an open config types it as unknown. */
function connectTimeoutOf(config: ConnectionConfig): number | undefined {
  const value = config['connectTimeoutMs']
  return typeof value === 'number' ? value : undefined
}
