import { create } from 'zustand'
import type { CommandInput, CommandName, CommandResultData } from '@peek/core'
import { parseCommandInput } from '@peek/core'
import { tryBridge } from '../bridge'
import { tStatic } from '../i18n'
import { notify, notifyError } from './notifyStore'
import { readWorkspace, resync } from './workspaceStore'

/**
 * Sending commands. **This is the only way the renderer changes anything** — the
 * view layer collects intent, main lands it, and the UI moves once the patch
 * arrives. No optimistic local updates, ever.
 */

interface BusyState {
  /** Commands in flight; the status bar shows this as a busy indicator. */
  inflight: number
}

export const useBusyStore = create<BusyState>(() => ({ inflight: 0 }))

/** How long to wait for a patch before realigning, when a command returned a
 *  revision newer than the mirror's. */
const PATCH_GRACE_MS = 400

export async function dispatch<K extends CommandName>(
  name: K,
  input: CommandInput<K>,
): Promise<CommandResultData<K> | null> {
  // Validate with zod at the door (the same ruler MCP is measured by) so main is
  // never bothered with malformed input
  const parsed = parseCommandInput(name, input)
  if (!parsed.ok) {
    notifyError(parsed.error, name)
    return null
  }

  const bridge = tryBridge()
  if (!bridge) {
    // Not a component: `tStatic` reads the locale once, which is exactly right for
    // a toast whose wording is fixed at push time.
    notify('error', tStatic('app.command.notSent'), tStatic('app.command.bridgeUnavailable'))
    return null
  }

  useBusyStore.setState((s) => ({ inflight: s.inflight + 1 }))
  try {
    const res = await bridge.invoke(name, parsed.input, 'ui')
    if (!res.ok) {
      notifyError(res.error, name)
      return null
    }
    scheduleRevCheck(res.rev)
    return res.data
  } catch (e) {
    notify('error', tStatic('app.command.threw', { name }), e instanceof Error ? e.message : String(e))
    return null
  } finally {
    useBusyStore.setState((s) => ({ inflight: Math.max(0, s.inflight - 1) }))
  }
}

/**
 * The command landed at `rev` but no patch arrived — pull a snapshot so the
 * mirror cannot fall permanently behind.
 *
 * The reason string is an internal diagnostic and stays an English literal: it
 * ends up in a toast detail and in bug reports, where a revision number needs to
 * read the same everywhere.
 */
function scheduleRevCheck(rev: number): void {
  const local = readWorkspace()?.rev ?? -1
  if (local >= rev) return
  setTimeout(() => {
    const now = readWorkspace()?.rev ?? -1
    if (now < rev) void resync(`command landed at rev ${rev}, mirror still at ${now}`)
  }, PATCH_GRACE_MS)
}
