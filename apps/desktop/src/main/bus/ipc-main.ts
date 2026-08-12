import type { IpcMain, WebContents } from 'electron'
import {
  IPC,
  isCommandName,
  type ChatDelta,
  type ChatDeltaMessage,
  type ChatId,
  type CommandName,
  type CommandSource,
  type InstalledPackages,
  type NotifyMessage,
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

export function sendNotify(renderers: readonly WebContents[], message: NotifyMessage): void {
  for (const wc of renderers) {
    if (!wc.isDestroyed()) wc.send(IPC.NOTIFY, message)
  }
}

/**
 * Tell every window what is installed now.
 *
 * A fan-out beside `sendNotify` rather than a patch: what is installed is not
 * Workspace state — no `rev`, no continuity check, nothing for MCP's
 * `read_workspace` to return — and `IPC.PACKAGES_CHANGED` records why it is also
 * not an answer on the synchronous read channel.
 *
 * The whole registry travels, not a delta. It is three small lists that change
 * when a person clicks a button, and the window replaces its copy wholesale
 * (`installPackages` refuses to merge, so that a package cannot survive its own
 * uninstall).
 */
export function sendPackagesChanged(
  renderers: readonly WebContents[],
  installed: InstalledPackages,
): void {
  for (const wc of renderers) {
    if (!wc.isDestroyed()) wc.send(IPC.PACKAGES_CHANGED, installed)
  }
}

/**
 * Ship one batch of chat transcript deltas to every renderer.
 *
 * The transcript's data plane, and the counterpart of `sendNotify` rather than
 * of the patch broadcast above: it carries no `rev`, participates in no
 * continuity check, and is append-only by construction. The batching that makes
 * this affordable happens upstream in the ACP host (`DeltaBatcher`), so this
 * function stays a plain fan-out.
 */
export function sendChatDeltas(
  renderers: readonly WebContents[],
  chatId: ChatId,
  deltas: readonly ChatDelta[],
): void {
  if (deltas.length === 0) return
  const message: ChatDeltaMessage = { chatId, deltas: [...deltas] }
  for (const wc of renderers) {
    if (!wc.isDestroyed()) wc.send(IPC.CHAT_DELTA, message)
  }
}

/**
 * The transcript's re-sync request, answered by whichever backend is running.
 *
 * Separate from `installBusIpc` because it is not the bus: nothing dispatched
 * here reaches a Command, nothing changes the Workspace, and the answer is a
 * bare boolean rather than a `CommandResult`. It is registered later too — the
 * chat host is assembled after the bus — so folding it into that function would
 * mean an option that is undefined for part of the process's life.
 *
 * Every failure answers `false`. A restore that throws would surface in the
 * renderer as a rejected promise on a path whose whole purpose is recovering
 * from a gap, and "nothing came back" is already a state the caller handles.
 */
export function installChatRestoreIpc(options: {
  ipcMain: IpcMain
  restore: (chatId: ChatId) => Promise<boolean>
}): () => void {
  const { ipcMain, restore } = options
  ipcMain.handle(IPC.CHAT_RESTORE, async (_event, raw: unknown): Promise<boolean> => {
    if (typeof raw !== 'string' || raw.length === 0) return false
    try {
      return await restore(raw as ChatId)
    } catch (error) {
      console.warn('[peek/chat] restore request failed', error)
      return false
    }
  })
  return () => {
    ipcMain.removeHandler(IPC.CHAT_RESTORE)
  }
}
