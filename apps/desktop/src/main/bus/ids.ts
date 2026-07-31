import {
  asConnId,
  asPanelId,
  asResultId,
  asSplitId,
  asViewId,
  newConnId,
  newPanelId,
  newResultId,
  newSplitId,
  newViewId,
  type ConnId,
  type PanelId,
  type ResultId,
  type SplitId,
  type ViewId,
} from '@peek/core'

/**
 * id 生成器。handler 的纯状态阶段只通过它拿新 id ——
 * 这样"纯函数"这件事在测试里是可兑现的：注入一个自增的假工厂，
 * 同样的输入就能得到逐字节相同的 Workspace。
 */
export interface IdFactory {
  conn(): ConnId
  view(): ViewId
  panel(): PanelId
  split(): SplitId
  result(): ResultId
}

export const defaultIdFactory: IdFactory = {
  conn: newConnId,
  view: newViewId,
  panel: newPanelId,
  split: newSplitId,
  result: newResultId,
}

/** 测试用：可复现的自增 id 工厂 */
export function createSeqIdFactory(prefix = 't'): IdFactory {
  const counters = new Map<string, number>()
  const next = (kind: string): string => {
    const n = (counters.get(kind) ?? 0) + 1
    counters.set(kind, n)
    return `${prefix}_${kind}${n}`
  }
  return {
    conn: () => asConnId(next('conn')),
    view: () => asViewId(next('view')),
    panel: () => asPanelId(next('panel')),
    split: () => asSplitId(next('split')),
    result: () => asResultId(next('res')),
  }
}
