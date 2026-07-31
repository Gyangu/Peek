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
 * IPC wiring on the main side (renderer ↔ Command Bus / Workspace Store).
 *
 * Electron appears in this file as **types only**; `ipcMain` is injected by the
 * caller, which is what lets the hub be unit-tested without an Electron runtime.
 */
export interface BusIpcOptions {
  ipcMain: IpcMain
  bus: CommandBus
  store: WorkspaceStore
  /** The renderers that should receive patches. A function, because the window may not exist yet or may already be destroyed. */
  renderers: () => readonly WebContents[]
}

export function installBusIpc(options: BusIpcOptions): () => void {
  const { ipcMain, bus, store, renderers } = options

  // Every change to the source of truth broadcasts a batch of patches. The
  // renderer mirror applies them by rev continuity, and pulls a fresh
  // STATE_SNAPSHOT to resynchronize whenever it spots a gap.
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
      // Not even the command name is valid: never reaches the bus, answer with a
      // structured error straight away.
      return {
        ok: false as const,
        commandId: 'invalid',
        error: { code: 'BAD_REQUEST' as const, message: 'Malformed command invoke message' },
      }
    }
    return bus.dispatch(parsed.name, parsed.input, parsed.source, parsed.commandId)
  })

  ipcMain.handle(IPC.STATE_SNAPSHOT, (): StateSnapshotMessage => {
    const state = store.getState()
    // Full snapshots need redacting too: ConnectionConfig holds a cleartext password.
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
 * Everything arriving from the renderer is treated as untrusted data.
 * `source` may only be ui or system: the renderer must not be able to pose as
 * mcp and poison the audit log.
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
/* Downstream channels the Connection Manager reuses                     */
/* ------------------------------------------------------------------ */

/**
 * Hand a connection's data-plane port over to the renderer.
 * The port must travel in webContents.postMessage's transfer list; it cannot be
 * packed into the message body.
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
