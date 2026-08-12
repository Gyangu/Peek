import type { Patch } from 'immer'
import {
  REDACTED,
  redactConnectionConfig,
  type ConnectionState,
  type Workspace,
} from '@peek/core'
import { parseConnectionConfig, redactRulesFor } from '../../drivers/manifests'

/**
 * The redaction layer for everything leaving the main process.
 *
 * ConnectionState.config holds a cleartext password and may exist only inside
 * main's source of truth. **Snapshots need redacting and so do patches** —
 * forget the latter and a single
 * `{op:'add', path:['connections','conn_1'], value:{...config:{password:'hunter2'}}}`
 * broadcasts the password straight to the renderer.
 */

/** Redact a full snapshot (used by STATE_SNAPSHOT) */
export function redactWorkspace(ws: Workspace): Workspace {
  const connections: Record<string, ConnectionState> = {}
  for (const [id, conn] of Object.entries(ws.connections)) {
    connections[id] = redactConnectionState(conn)
  }
  return { ...ws, connections: connections as Workspace['connections'] }
}

export function redactConnectionState(conn: ConnectionState): ConnectionState {
  return { ...conn, config: redactConnectionConfig(conn.config, redactRulesFor(conn.driverId)) }
}

/** Redact broadcast patches (used by STATE_PATCH) */
export function redactPatches(patches: readonly Patch[]): Patch[] {
  return patches.map(redactPatch)
}

function redactPatch(patch: Patch): Patch {
  const path = patch.path
  if (path[0] !== 'connections') return patch

  // ['connections'] — the whole table was replaced
  if (path.length === 1) {
    return { ...patch, value: redactConnectionsRecord(patch.value) }
  }
  // ['connections', id] — a single connection was added, removed or replaced
  if (path.length === 2) {
    return { ...patch, value: redactMaybeConnection(patch.value) }
  }
  if (path[2] !== 'config') return patch
  // ['connections', id, 'config'] — the whole config was replaced
  if (path.length === 3) {
    return { ...patch, value: redactMaybeConfig(patch.value) }
  }
  // ['connections', id, 'config', 'password' | 'apiKey' | 'url' | ...] — one field
  return isSecretField(path[3]) ? { ...patch, value: REDACTED } : patch
}

/**
 * The one scrubbing decision in peek that is **not** taken from a driver's
 * `redact` rules. Said plainly so nobody reads the rest of this file and assumes
 * otherwise.
 *
 * It cannot be: a patch is a path and a value, and `['connections', id, 'config',
 * field]` carries no `driverId` to look the rules up by. Answering it would mean
 * handing `redactPatches` the post-change workspace so it could read
 * `connections[id].driverId` back out — a second argument, threaded from
 * `ipc-main.ts`, for a branch nothing reaches.
 *
 * Nothing reaches it today, and that is what makes leaving it safe rather than
 * merely convenient: a config is only ever written whole (`conn.open` replaces
 * the `ConnectionState`), and `store/mutations.ts` never touches `config` at all,
 * so immer has no way to emit a patch this deep. Everything that does arrive is
 * caught one level up by `redactMaybeConfig`, which *is* rules-driven. The list
 * below is a backstop for a shape the store cannot currently produce.
 *
 * **What breaks it**: the first mutation that assigns a single config field.
 * Whoever writes it has to either come back here or take the workspace argument —
 * because from that moment a package's own secret field, whatever it is called,
 * would broadcast in the clear while the three names below still pass.
 */
const SECRET_FIELDS = new Set(['password', 'apiKey', 'url'])

function isSecretField(field: string | number): boolean {
  return typeof field === 'string' && SECRET_FIELDS.has(field)
}

function redactConnectionsRecord(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const [id, conn] of Object.entries(value as Record<string, unknown>)) {
    out[id] = redactMaybeConnection(conn)
  }
  return out
}

function redactMaybeConnection(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (!('config' in record)) return value
  return { ...record, config: redactMaybeConfig(record['config']) }
}

function redactMaybeConfig(value: unknown): unknown {
  // Through the registry, not core's open schema: that one accepts any record
  // with a servable `driverId`, so a config for a driver peek does not have
  // would parse, answer `{}` rules, and travel verbatim. Refusing it here is
  // what keeps this branch meaning what it says.
  const config = parseConnectionConfig(value, 'keep')
  // Anything unparseable is wiped wholesale: better to under-report than to leak a password
  if (config === null) return REDACTED
  return redactConnectionConfig(config, redactRulesFor(config.driverId))
}
