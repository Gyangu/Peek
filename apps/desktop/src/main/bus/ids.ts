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
 * Id factory. A handler's pure state phase mints new ids only through this,
 * which is what makes "pure function" a claim tests can actually cash: inject a
 * counting fake and the same input yields a byte-identical Workspace.
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

/** For tests: a reproducible counting id factory. */
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
