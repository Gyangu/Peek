import { create } from 'zustand'
import type { CommandInput, CommandName, CommandResultData } from '@peek/core'
import { parseCommandInput } from '@peek/core'
import { tryBridge } from '../bridge'
import { notify, notifyError } from './notifyStore'
import { readWorkspace, resync } from './workspaceStore'

/**
 * 命令下发。**这是 renderer 改变任何状态的唯一途径**——
 * 视图层只采集用户意图，交给 main 落地，等 patch 回来才更新界面。
 * 这里绝不做任何本地乐观更新。
 */

interface BusyState {
  /** 在途命令数，状态栏用它显示忙碌指示 */
  inflight: number
}

export const useBusyStore = create<BusyState>(() => ({ inflight: 0 }))

/** 命令返回的 rev 比镜像新、但 patch 迟迟不到时的兜底重对齐延时 */
const PATCH_GRACE_MS = 400

export async function dispatch<K extends CommandName>(
  name: K,
  input: CommandInput<K>,
): Promise<CommandResultData<K> | null> {
  // 入口先过 zod 校验（与 MCP 共用同一把尺子），不合法就不打扰 main
  const parsed = parseCommandInput(name, input)
  if (!parsed.ok) {
    notifyError(parsed.error, name)
    return null
  }

  const bridge = tryBridge()
  if (!bridge) {
    notify('error', '命令未发出', 'preload 桥不可用，无法与 main 通信')
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
    notify('error', `命令 ${name} 执行异常`, e instanceof Error ? e.message : String(e))
    return null
  } finally {
    useBusyStore.setState((s) => ({ inflight: Math.max(0, s.inflight - 1) }))
  }
}

/** 命令已落地到 rev，但 patch 没广播到 —— 兜底拉一次快照，避免镜像永久落后 */
function scheduleRevCheck(rev: number): void {
  const local = readWorkspace()?.rev ?? -1
  if (local >= rev) return
  setTimeout(() => {
    const now = readWorkspace()?.rev ?? -1
    if (now < rev) void resync(`命令已落地到 rev ${rev}，镜像仍停在 ${now}`)
  }, PATCH_GRACE_MS)
}
