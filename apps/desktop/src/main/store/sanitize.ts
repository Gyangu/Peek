import type { Patch } from 'immer'
import {
  ConnectionConfigSchema,
  REDACTED,
  redactConnectionConfig,
  type ConnectionState,
  type Workspace,
} from '@peek/core'

/**
 * 出 main 进程的脱敏层。
 *
 * ConnectionState.config 含明文口令，只允许存在于 main 的真源里。
 * **快照要脱敏，patch 同样要脱敏** —— 忘了后者的话，一条
 * `{op:'add', path:['connections','conn_1'], value:{...config:{password:'真密码'}}}`
 * 就把口令直接广播到 renderer 了。
 */

/** 全量快照脱敏（STATE_SNAPSHOT 用） */
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

/** patch 广播脱敏（STATE_PATCH 用） */
export function redactPatches(patches: readonly Patch[]): Patch[] {
  return patches.map(redactPatch)
}

function redactPatch(patch: Patch): Patch {
  const path = patch.path
  if (path[0] !== 'connections') return patch

  // ['connections'] 整个表被替换
  if (path.length === 1) {
    return { ...patch, value: redactConnectionsRecord(patch.value) }
  }
  // ['connections', id] 单个连接被增删改
  if (path.length === 2) {
    return { ...patch, value: redactMaybeConnection(patch.value) }
  }
  if (path[2] !== 'config') return patch
  // ['connections', id, 'config'] 整个 config 被替换
  if (path.length === 3) {
    return { ...patch, value: redactMaybeConfig(patch.value) }
  }
  // ['connections', id, 'config', 'password' | 'apiKey' | 'url' | ...] 单字段
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
  // 解析不了的一律整体抹掉，宁可少给也不能漏口令
  return parsed.success ? redactConnectionConfig(parsed.data) : REDACTED
}
