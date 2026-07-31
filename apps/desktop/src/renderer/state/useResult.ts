import { useCallback, useSyncExternalStore } from 'react'
import type { ResultId } from '@peek/core'
import type { CacheStats, ResultSnapshot } from './resultCache'
import {
  EMPTY_SNAPSHOT,
  getCacheStats,
  getResultSnapshot,
  subscribeCacheStats,
  subscribeResult,
} from './resultCache'

const NOOP_UNSUB = (): void => {}

/**
 * 订阅某个结果集的状态。
 * 返回的快照对象只在 version 变化时换新引用，
 * 因此滚动（不改变 version）不会触发任何重渲染。
 */
export function useResult(resultId: ResultId | null | undefined): ResultSnapshot {
  const subscribe = useCallback(
    (cb: () => void) => (resultId ? subscribeResult(resultId, cb) : NOOP_UNSUB),
    [resultId],
  )
  const snapshot = useCallback(
    () => (resultId ? getResultSnapshot(resultId) : EMPTY_SNAPSHOT),
    [resultId],
  )
  return useSyncExternalStore(subscribe, snapshot)
}

export function useCacheStats(): CacheStats {
  return useSyncExternalStore(subscribeCacheStats, getCacheStats)
}
