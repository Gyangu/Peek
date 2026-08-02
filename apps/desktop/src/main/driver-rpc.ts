import type { IpcMain } from 'electron'
import {
  IPC,
  isKeyValueShape,
  toPeekError,
  type ConnId,
  type DriverRpcRequest,
  type DriverRpcResponse,
  type KeyValueResult,
  type KeyValueWindow,
  type NamespaceNode,
  type PeekedValue,
  type ValueRef,
} from '@peek/core'

/**
 * The non-command read-only RPC channel (renderer → main → driver host).
 *
 * Why these are not Commands: all 12 commands in PLAN section 6 are **state
 * changes**, whereas a namespace tree's child nodes, a large value's full
 * contents and redis's typed reads never enter the Workspace source of truth —
 * putting them there would mean broadcasting an entire tree or an entire blob in
 * a patch. They only make sense as one-shot read-only queries.
 *
 * The channel is kept deliberately narrow:
 * - three kinds only, with parameters matching HostRpcMap one for one;
 * - no state changes, no patch broadcast, no Command log entry;
 * - every error is collapsed through toPeekError, so a raw Error never crosses IPC.
 */
export interface DriverRpcOptions {
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>
  getKeyValue(connId: ConnId, ref: ValueRef, window?: KeyValueWindow): Promise<KeyValueResult>
}

export interface DriverRpcInstallOptions extends DriverRpcOptions {
  ipcMain: IpcMain
}

export function installDriverRpc(options: DriverRpcInstallOptions): () => void {
  const { ipcMain } = options

  ipcMain.handle(IPC.DRIVER_RPC, async (_event, raw: unknown): Promise<DriverRpcResponse> => {
    const req = readRequest(raw)
    if (!req) {
      return { ok: false, error: toPeekError(new Error('Malformed driver RPC message')) }
    }
    try {
      switch (req.kind) {
        case 'introspect': {
          const data = await options.introspect(req.connId, req.parentId, req.refresh)
          return { ok: true, data }
        }
        case 'peekValue': {
          const data = await options.peekValue(req.connId, req.ref, req.range)
          return { ok: true, data }
        }
        case 'keyValue': {
          const data = await options.getKeyValue(req.connId, req.ref, req.window)
          return { ok: true, data }
        }
      }
    } catch (raw2) {
      return { ok: false, error: toPeekError(raw2) }
    }
  })

  return () => {
    ipcMain.removeHandler(IPC.DRIVER_RPC)
  }
}

/**
 * Everything arriving from the renderer is treated as untrusted data.
 * This only validates shape (a known kind plus the required fields); whether a
 * particular ref or connId is actually valid is the driver's problem.
 */
function readRequest(raw: unknown): DriverRpcRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const connId = rec['connId']
  if (typeof connId !== 'string') return null
  const id = connId as ConnId

  switch (rec['kind']) {
    case 'introspect': {
      const parentId = rec['parentId']
      if (parentId !== null && typeof parentId !== 'string' && parentId !== undefined) return null
      const refresh = rec['refresh']
      return {
        kind: 'introspect',
        connId: id,
        parentId: typeof parentId === 'string' ? parentId : null,
        ...(typeof refresh === 'boolean' ? { refresh } : {}),
      }
    }
    case 'peekValue': {
      const ref = rec['ref']
      if (typeof ref !== 'object' || ref === null) return null
      const range = readRange(rec['range'])
      return {
        kind: 'peekValue',
        connId: id,
        ref: ref as ValueRef,
        ...(range === null ? {} : { range }),
      }
    }
    case 'keyValue': {
      const ref = rec['ref']
      if (typeof ref !== 'object' || ref === null) return null
      const window = readKeyValueWindow(rec['window'])
      return {
        kind: 'keyValue',
        connId: id,
        ref: ref as ValueRef,
        ...(window === null ? {} : { window }),
      }
    }
    default:
      return null
  }
}

/**
 * The paging window of a keyValue read, rebuilt field by field.
 *
 * Every field is dropped rather than clamped when it is not a finite number: the
 * driver owns the ceilings (MAX_KEY_VALUE_ELEMENTS and friends), and a `limit`
 * of NaN silently becoming 0 would look like an empty hash. `cursorToken` and
 * `match` are opaque strings that the driver validates — a malformed cursor is a
 * BAD_REQUEST there, which is more useful than being swallowed here.
 *
 * `shape` is the exception: it is checked against the known set rather than
 * merely typed as a string, because `keyValueReadOptions` switches on it and an
 * unrecognised value falls through to the branch that *infers* the addressing.
 * Dropping this field here — which is what happened until now — meant that
 * branch was the only one production ever took.
 */
function readKeyValueWindow(raw: unknown): KeyValueWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const shape = rec['shape']
  const limit = rec['limit']
  const offset = rec['offset']
  const cursorToken = rec['cursorToken']
  const match = rec['match']
  const window: KeyValueWindow = {
    ...(isKeyValueShape(shape) ? { shape } : {}),
    ...(typeof limit === 'number' && Number.isFinite(limit)
      ? { limit: Math.max(1, Math.trunc(limit)) }
      : {}),
    ...(typeof offset === 'number' && Number.isFinite(offset)
      ? { offset: Math.max(0, Math.trunc(offset)) }
      : {}),
    ...(typeof cursorToken === 'string' ? { cursorToken } : {}),
    ...(typeof match === 'string' ? { match } : {}),
  }
  return Object.keys(window).length === 0 ? null : window
}

function readRange(raw: unknown): { offset: number; length: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const offset = rec['offset']
  const length = rec['length']
  if (typeof offset !== 'number' || typeof length !== 'number') return null
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return null
  return { offset: Math.max(0, Math.trunc(offset)), length: Math.max(0, Math.trunc(length)) }
}
