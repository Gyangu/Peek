import type { ReactElement } from 'react'
import type { ConnectionState, ResultId, ViewId } from '@peek/core'
import { useT } from '../../i18n'
import { connHas } from '../../state/capabilities'
import { dispatch } from '../../state/dispatch'
import { useResult } from '../../state/useResult'

/**
 * The controls every result view shares: stop the request, and say something when
 * the rows on screen have been dropped from the cache.
 *
 * They live together because they are the same promise from two sides — *you can
 * see what the data plane is doing to you, and you can do something about it*.
 * Before M6 each view answered that differently: the query view had a Cancel
 * button, the vector view had one only on drivers that declare `cancel`, and the
 * table view — the one most likely to be walking a million-row scan — had none at
 * all.
 */

/* ================================================================== */
/* Cancel                                                              */
/* ================================================================== */

export interface CancelButtonProps {
  viewId: ViewId
  /** The view's connection; null while the mirror has not caught up. */
  conn: ConnectionState | null
  /** A request is in flight for this view. */
  running: boolean
}

/**
 * Stop the request this view is running.
 *
 * ## Why it is always drawn
 *
 * The vector view used to hide it entirely on a driver without the `cancel`
 * capability, reasoning that peek can only stop such a driver by killing its
 * process and that calling that "Cancel" understates the cost. The reasoning was
 * right and the conclusion was wrong: **an absent button explains nothing**. A
 * user watching a qdrant scroll they regret has no way to learn why there is no
 * way to stop it, and no way to tell that case apart from a bug.
 *
 * So the button is always there, and the two cases are told apart in the only way
 * that helps — by what happens when you press it, and by what the tooltip says
 * will happen. Where the driver cooperates, the request stops and the connection
 * lives. Where it does not, the control is disabled and carries the reason
 * instead of pretending: peek's only remaining lever is killing the driver
 * process, which takes the connection with it, and firing that from a button
 * labelled "Cancel" is not a thing to do to someone by surprise. The escape hatch
 * for that case is closing the connection, which says what it does.
 *
 * (The **deadline** still applies either way: a request that outlives its budget
 * is stopped by main regardless of what the driver can do — see
 * `main/connections/deadline.ts`. This button is about doing it early, not about
 * whether it happens at all.)
 */
export function CancelButton({ viewId, conn, running }: CancelButtonProps): ReactElement {
  const t = useT()
  const cancellable = conn !== null && connHas(conn, 'cancel')

  const cancel = (): void => {
    void dispatch('query.cancel', { viewId })
  }

  if (!cancellable) {
    return (
      <button
        className="ghost"
        disabled
        title={t('result.cancelUnsupportedTitle', { driverId: conn?.driverId ?? '—' })}
        aria-label={t('result.cancelUnsupportedTitle', { driverId: conn?.driverId ?? '—' })}
      >
        ■ {t('result.cancelUnsupported')}
      </button>
    )
  }

  return (
    <button className="ghost" disabled={!running} onClick={cancel} title={t('result.cancelTitle')}>
      ■ {t('result.cancel')}
    </button>
  )
}

/* ================================================================== */
/* Cache gap                                                           */
/* ================================================================== */

export interface CacheGapNoticeProps {
  resultId: ResultId | undefined
  /** Re-run the request that produced this result — the only way to refill it. */
  onRefetch: () => void
  /** The re-run is not available right now (disconnected, or nothing to re-run). */
  disabled?: boolean
}

/**
 * "The rows you are looking at were dropped to stay inside the cache budget."
 *
 * The cache keeps ~200MB of rows and evicts the chunks furthest from the viewport
 * (PLAN section 8). Scrolling back into an evicted range used to show correct row
 * numbers over blank cells and no explanation at all — indistinguishable from data
 * loss, from a stalled stream, or from a bug.
 *
 * Refilling just the missing range is not possible and the notice does not pretend
 * otherwise: the result was streamed from a cursor that has since been closed, and
 * neither a query nor a finished scan can be asked for "rows 40000-41000 again"
 * (the reasoning is spelled out in `recomputeEvictedInView`). Re-running the whole
 * request is the honest refill, so that is what the button does, and the wording
 * says so rather than implying a cheap repair.
 *
 * It renders only while the viewport actually overlaps a hole, so a large result
 * that has been evicted somewhere far away stays quiet.
 */
export function CacheGapNotice({ resultId, onRefetch, disabled }: CacheGapNoticeProps): ReactElement | null {
  const t = useT()
  const snap = useResult(resultId)
  if (!snap.evictedInViewport) return null
  return (
    <div className="view-error cache-gap" role="status" style={CACHE_GAP_STYLE}>
      <div>
        <strong>{t('result.cacheGap')}</strong> {t('result.cacheGapDetail')}
      </div>
      <button className="ghost" disabled={disabled === true} onClick={onRefetch}>
        ⟳ {t('result.cacheGapRefetch')}
      </button>
    </div>
  )
}

/**
 * Inline rather than a stylesheet rule: this reuses `.view-error`'s box so it sits
 * exactly where an error bar would, and only needs the row layout that a bar with
 * a button on the right requires. Reaching into the global stylesheet for four
 * declarations would spread one component across two files.
 *
 * The colour is `--warn`, not the error red `.view-error` carries: nothing has
 * failed here, and every row still on screen is real.
 */
const CACHE_GAP_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  borderColor: 'var(--warn)',
  color: 'var(--warn)',
} as const
