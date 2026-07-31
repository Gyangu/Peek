import type { IpcMain, MessagePortMain, WebContents } from 'electron'
import {
  IPC,
  isCommandName,
  type CommandName,
  type CommandSource,
  type NotifyMessage,
  type ResultPortMessage,
  type StatePatchMessage,
  type StateSnapshotMessage,
} from '@peek/core'
import { redactPatches, redactWorkspace } from '../store/sanitize'
import type { WorkspaceStore } from '../store/workspace-store'
import type { CommandBus } from './command-bus'

/**
 * main 侧 IPC 装配（renderer ↔ Command Bus / Workspace Store）。
 *
 * electron 只作为**类型**出现在这个文件里，ipcMain 由调用方注入 ——
 * 中枢因此可以在没有 Electron 的环境里单测。
 */
export interface BusIpcOptions {
  ipcMain: IpcMain
  bus: CommandBus
  store: WorkspaceStore
  /** 当前需要接收 patch 的 renderer；窗口可能还没建/已销毁，所以是个函数 */
  renderers: () => readonly WebContents[]
}

export function installBusIpc(options: BusIpcOptions): () => void {
  const { ipcMain, bus, store, renderers } = options

  // 真源每变一次就广播一批 patch；renderer 镜像按 rev 连续性应用，
  // 断层时自己去拉 STATE_SNAPSHOT 重新对齐
  const unsubscribe = store.subscribe((change) => {
    const message: StatePatchMessage = {
      fromRev: change.fromRev,
      rev: change.rev,
      patches: redactPatches(change.patches),
      ...(change.commandId ? { commandId: change.commandId } : {}),
      ...(change.commandName ? { commandName: change.commandName } : {}),
    }
    for (const wc of renderers()) {
      if (!wc.isDestroyed()) wc.send(IPC.STATE_PATCH, message)
    }
  })

  ipcMain.handle(IPC.COMMAND_INVOKE, async (_event, raw: unknown) => {
    const parsed = readInvokeMessage(raw)
    if (!parsed) {
      // 连命令名都不对：不进 bus，直接回一条结构化错误
      return {
        ok: false as const,
        commandId: 'invalid',
        error: { code: 'BAD_REQUEST' as const, message: 'command invoke 消息格式不正确' },
      }
    }
    return bus.dispatch(parsed.name, parsed.input, parsed.source, parsed.commandId)
  })

  ipcMain.handle(IPC.STATE_SNAPSHOT, (): StateSnapshotMessage => {
    const state = store.getState()
    // 全量快照同样要脱敏：ConnectionConfig 里有明文口令
    return { rev: state.rev, workspace: redactWorkspace(state) }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.COMMAND_INVOKE)
    ipcMain.removeHandler(IPC.STATE_SNAPSHOT)
  }
}

interface InvokeMessage {
  name: CommandName
  input: unknown
  source: CommandSource
  commandId?: string
}

/**
 * renderer 来的消息一律当不可信数据处理。
 * source 只允许 ui / system：renderer 不能把自己伪装成 mcp 污染审计日志。
 */
function readInvokeMessage(raw: unknown): InvokeMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const name = record['name']
  if (!isCommandName(name)) return null
  const commandId = record['commandId']
  return {
    name,
    input: record['input'],
    source: record['source'] === 'system' ? 'system' : 'ui',
    ...(typeof commandId === 'string' ? { commandId } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* 供 Connection Manager 复用的下行通道                                   */
/* ------------------------------------------------------------------ */

/**
 * 把某个连接的数据面端口移交给 renderer。
 * 端口必须走 webContents.postMessage 的 transfer 列表，不能塞进消息体。
 */
export function sendResultPort(wc: WebContents, message: ResultPortMessage, port: MessagePortMain): void {
  if (wc.isDestroyed()) return
  wc.postMessage(IPC.RESULT_PORT, message, [port])
}

export function sendNotify(renderers: readonly WebContents[], message: NotifyMessage): void {
  for (const wc of renderers) {
    if (!wc.isDestroyed()) wc.send(IPC.NOTIFY, message)
  }
}
