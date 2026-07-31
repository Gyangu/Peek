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
 * Subscribe to the state of one result set.
 *
 * The snapshot object only takes a new reference when `version` changes, so
 * scrolling — which leaves the version alone — triggers no re-render at all.
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
