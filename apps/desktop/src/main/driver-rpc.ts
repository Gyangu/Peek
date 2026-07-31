import type { IpcMain } from 'electron'
import {
  IPC,
  toPeekError,
  type ConnId,
  type DriverRpcRequest,
  type DriverRpcResponse,
  type KeyValueResult,
  type NamespaceNode,
  type PeekedValue,
  type ValueRef,
} from '@peek/core'

/**
 * 非命令类只读 RPC 通道（renderer → main → driver host）。
 *
 * 为什么不做成 Command：PLAN 第 6 节的 12 条命令都是**状态变更**，
 * 而命名空间树的子节点、大 value 的全量内容、redis 的类型化取值
 * 三者都不进 Workspace 真源（进了就等于把整棵树和整块 blob 塞进 patch 广播），
 * 所以它们只适合做一次性的只读查询。
 *
 * 这条通道刻意保持极窄：
 * - 只有三个 kind，参数与 HostRpcMap 一一对应；
 * - 不改状态、不广播 patch、不进 Command 日志；
 * - 错误一律 toPeekError 收敛，绝不把原始 Error 扔过 IPC。
 */
export interface DriverRpcOptions {
  introspect(connId: ConnId, parentId: string | null, refresh?: boolean): Promise<NamespaceNode[]>
  peekValue(
    connId: ConnId,
    ref: ValueRef,
    range?: { offset: number; length: number },
  ): Promise<PeekedValue>
  getKeyValue(connId: ConnId, ref: ValueRef): Promise<KeyValueResult>
}

export interface DriverRpcInstallOptions extends DriverRpcOptions {
  ipcMain: IpcMain
}

export function installDriverRpc(options: DriverRpcInstallOptions): () => void {
  const { ipcMain } = options

  ipcMain.handle(IPC.DRIVER_RPC, async (_event, raw: unknown): Promise<DriverRpcResponse> => {
    const req = readRequest(raw)
    if (!req) {
      return { ok: false, error: toPeekError(new Error('driver RPC 消息格式不正确')) }
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
          const data = await options.getKeyValue(req.connId, req.ref)
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
 * renderer 来的消息一律当不可信数据处理。
 * 这里只做形状校验（kind + 必填字段存在），具体的 ref / connId 合法性由 driver 侧兜底。
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
      return { kind: 'keyValue', connId: id, ref: ref as ValueRef }
    }
    default:
      return null
  }
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
