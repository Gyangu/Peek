import type { Patch } from 'immer'
import {
  ConnectionConfigSchema,
  REDACTED,
  redactConnectionConfig,
  type ConnectionState,
  type Workspace,
} from '@peek/core'

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
  return { ...conn, config: redactConnectionConfig(conn.config) }
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
  const parsed = ConnectionConfigSchema.safeParse(value)
  // Anything unparseable is wiped wholesale: better to under-report than to leak a password
  return parsed.success ? redactConnectionConfig(parsed.data) : REDACTED
}
