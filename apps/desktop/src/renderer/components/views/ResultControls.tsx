import { useState } from 'react'
import type { ReactElement } from 'react'
import type { AutoRefreshStopReason, ConnectionState, RefreshableView, ResultId, ViewId } from '@peek/core'
import { useT } from '../../i18n'
import { connHas } from '../../state/capabilities'
import { dispatch } from '../../state/dispatch'
import { useResult } from '../../state/useResult'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Menu } from '../../ui/Menu'
import type { Point } from '../../ui/menuModel'
import { autoRefreshMenuNodes, formatInterval } from './autoRefreshMenu'

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
      <Button
        variant="ghost"
        disabled
        title={t('result.cancelUnsupportedTitle', { driverId: conn?.driverId ?? '—' })}
        aria-label={t('result.cancelUnsupportedTitle', { driverId: conn?.driverId ?? '—' })}
      >
        <Icon name="stop" />
        {t('result.cancelUnsupported')}
      </Button>
    )
  }

  return (
    <Button variant="ghost" disabled={!running} onClick={cancel} title={t('result.cancelTitle')}>
      <Icon name="stop" />
      {t('result.cancel')}
    </Button>
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
    <div
      className="m-tight flex flex-none items-center gap-snug rounded-control border border-warn bg-err-bg px-snug py-tight text-warn select-text"
      role="status"
    >
      <div>
        <strong>{t('result.cacheGap')}</strong> {t('result.cacheGapDetail')}
      </div>
      <Button variant="ghost" disabled={disabled === true} onClick={onRefetch}>
        <Icon name="refresh" />
        {t('result.cacheGapRefetch')}
      </Button>
    </div>
  )
}

/* ================================================================== */
/* Auto-refresh                                                        */
/* ================================================================== */

export interface AutoRefreshControlProps {
  viewId: ViewId
  /** The view's kind, which is also the patch kind `view.update` needs. */
  kind: RefreshableView['kind']
  /** The interval in force; absent means off. */
  autoRefreshMs?: number
  /** Set when auto-refresh stopped itself — the menu explains it. */
  stoppedBy?: AutoRefreshStopReason
}

/**
 * "Fetch this view again every N seconds."
 *
 * The button reports the interval instead of only being lit, because the two
 * questions a reader has about a view that is redrawing itself are *is it on* and
 * *how fast* — and the second one is the one they cannot recover by looking.
 *
 * It sits with Cancel and the cache-gap notice because it belongs to the same
 * promise those two make: you can see what the data plane is doing to you, and
 * you can do something about it. What it does *not* do is fetch: turning the
 * timer on schedules the first tick one interval away, and the Refresh button an
 * inch to its left is how you say "now".
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md
 */
export function AutoRefreshControl(props: AutoRefreshControlProps): ReactElement {
  const { viewId, kind, autoRefreshMs, stoppedBy } = props
  const t = useT()
  const [at, setAt] = useState<Point | null>(null)

  const units = { s: t('autoRefresh.unitS'), min: t('autoRefresh.unitMin'), h: t('autoRefresh.unitH') }
  const current = autoRefreshMs ?? null
  const label = current === null ? t('autoRefresh.off') : formatInterval(current, units)

  const nodes = autoRefreshMenuNodes({
    currentMs: current,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    labels: {
      off: t('autoRefresh.off'),
      interval: (ms) => formatInterval(ms, units),
      stoppedNote: (reason) =>
        reason === 'paged' ? t('autoRefresh.stoppedPaged') : t('autoRefresh.stoppedError'),
    },
    onSelect: (ms) => {
      setAt(null)
      // `patch.kind` has to match the view's kind — main answers BAD_REQUEST
      // otherwise — so the caller passes it down rather than this control
      // guessing.
      void dispatch('view.update', { viewId, patch: { kind, autoRefreshMs: ms } })
    },
  })

  return (
    <>
      <Button
        variant={current === null ? 'ghost' : 'primary'}
        action="view.autoRefresh"
        title={current === null ? t('autoRefresh.title') : t('autoRefresh.onTitle', { interval: label })}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: r.left, y: r.bottom })
        }}
      >
        <Icon name="autoRefresh.timer" />
        {label}
        <Icon name="disclosure.open" size="sm" />
      </Button>
      {at ? (
        <Menu
          label={t('autoRefresh.menuLabel')}
          at={at}
          nodes={nodes}
          onClose={() => {
            setAt(null)
          }}
        />
      ) : null}
    </>
  )
}

/*
 * The inline style that used to sit here is gone, and the condition its own note
 * named is what removed it.
 *
 * It read: "Reconsider when the app sheet migrates: if the error box becomes
 * utilities on `ViewError`, this borrows nothing and has to state its own shape."
 * That happened this round (migration record §17). The box was a named rule in an
 * **unlayered** sheet, so an amber border and an amber colour written as
 * utilities lost to the rule's red ones however specific they were, and an inline
 * style was the only writing that still won. Nothing outranks anything now:
 * both boxes state their whole shape on their own element.
 *
 * The one thing the old note was right to fear is still true and is now the
 * reader's job rather than the cascade's — these two boxes and the chat panel's
 * error block are three statements of one visual fact, and the two that were
 * literally the same rule twice over are why `--color-err-border` exists at all.
 * The tokens are the shared part; the shapes are not. If a fourth appears, name
 * the shape before copying it.
 *
 * The colour is `--color-warn`, not the error red: nothing has failed here, and
 * every row still on screen is real. The background stays the error block's —
 * amber on it reads fine, and repainting it is a look change, not a migration.
 */
