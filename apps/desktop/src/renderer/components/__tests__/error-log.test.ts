import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { peekError } from '@peek/core'

/* ==================================================================
 * M6 — the error centre's ring.
 *
 * The panel is the visible part; this is the part that has to be right. Before
 * it, a failure had two homes and both lost it: `ViewError` shows one error in
 * one pane until the next fetch overwrites it, and a toast is gone in seconds or
 * as soon as it is the sixth. Main's Command log — which does keep 500 entries
 * with source and error code — had no UI at all.
 *
 * Covered here: the ring's bounds, what makes an entry, the source attribution
 * rules, the degraded-data-plane report, and the clipboard format, which is the
 * whole reason the panel is worth opening.
 * ================================================================== */

const log = await import('../error-center/errorLog')

beforeEach(() => {
  log.clearErrorLog()
  log.closeErrorCenter()
})

describe('the ring', () => {
  it('keeps the newest entries and drops the oldest past capacity', () => {
    for (let i = 0; i < log.ERROR_LOG_CAPACITY + 25; i += 1) {
      log.recordError({ source: 'ui', code: 'INTERNAL', message: `boom ${i}` })
    }
    const entries = log.useErrorLog.getState().entries
    assert.equal(entries.length, log.ERROR_LOG_CAPACITY)
    assert.equal(entries[entries.length - 1].message, `boom ${log.ERROR_LOG_CAPACITY + 24}`)
    assert.equal(entries[0].message, 'boom 25', 'the oldest 25 were dropped, not the newest')
  })

  it('ids are monotonic, so the panel can key rows without re-sorting', () => {
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'a' })
    log.recordError({ source: 'mcp', code: 'INTERNAL', message: 'b' })
    const [a, b] = log.useErrorLog.getState().entries
    assert.ok(b.id > a.id)
    assert.ok(b.ts >= a.ts)
  })
})

describe('the unseen badge', () => {
  it('counts while the panel is closed and resets when it is opened', () => {
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'a' })
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'b' })
    assert.equal(log.useErrorLog.getState().unseen, 2)

    log.openErrorCenter()
    assert.equal(log.useErrorLog.getState().unseen, 0)

    // Anything arriving while it is open is already on screen.
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'c' })
    assert.equal(log.useErrorLog.getState().unseen, 0)

    log.closeErrorCenter()
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'd' })
    assert.equal(log.useErrorLog.getState().unseen, 1)
  })

  it('toggling open clears the badge; toggling shut does not resurrect it', () => {
    log.recordError({ source: 'system', code: 'INTERNAL', message: 'a' })
    log.toggleErrorCenter()
    assert.equal(log.useErrorLog.getState().open, true)
    assert.equal(log.useErrorLog.getState().unseen, 0)
    log.toggleErrorCenter()
    assert.equal(log.useErrorLog.getState().open, false)
    assert.equal(log.useErrorLog.getState().unseen, 0)
  })
})

describe('the clipboard format', () => {
  it('carries every field somebody debugging would ask for', () => {
    const err = peekError('SYNTAX_ERROR', 'syntax error at or near "slect"', {
      driverCode: '42601',
      position: 1,
      retryable: false,
      detail: 'LINE 1: slect 1\n        ^',
    })
    log.recordError({
      source: 'ui',
      code: err.code,
      message: err.message,
      detail: err.detail!,
      error: err,
      context: 'view_3',
    })
    const [entry] = log.useErrorLog.getState().entries
    const text = log.formatEntry(entry)

    assert.match(text, /\[ui\]/)
    assert.match(text, /SYNTAX_ERROR/)
    assert.match(text, /view_3/)
    assert.match(text, /syntax error at or near/)
    assert.match(text, /driverCode=42601/)
    assert.match(text, /position=1/)
    assert.match(text, /retryable=false/)
    assert.match(text, /LINE 1: slect 1/)
    // An ISO instant, not a locale clock: a copied report travels, and a report
    // that reads differently in two languages is worse than no report.
    assert.match(text, /\d{4}-\d{2}-\d{2}T/)
  })

  it('an empty log copies as something readable rather than as nothing', () => {
    assert.match(log.formatErrorLog([]), /empty/)
  })

  it('the whole log copies newest last, so a paste reads in the order things happened', () => {
    log.recordError({ source: 'ui', code: 'INTERNAL', message: 'first' })
    log.recordError({ source: 'mcp', code: 'INTERNAL', message: 'second' })
    const text = log.formatErrorLog(log.useErrorLog.getState().entries)
    assert.ok(text.indexOf('first') < text.indexOf('second'))
    assert.match(text, /2 entries/)
  })
})

/* ------------------------------------------------------------------ *
 * Collection from the toast channel.
 *
 * `notifyError` is the only thing that produces a `[CODE] …` message and it can
 * only be called from renderer code, which is what makes the shape a reliable
 * "this window asked for it" marker. Everything else on that channel arrived
 * from main over NOTIFY.
 * ------------------------------------------------------------------ */

describe('source attribution', () => {
  it('a [CODE]-shaped toast is this window’s own command failing', async () => {
    const { notifyError } = await import('../../state/notifyStore')
    log.startErrorCollection()
    log.clearErrorLog()

    notifyError(peekError('BAD_REQUEST', 'Provide either resultId or viewId'), 'query.cancel')

    const entries = log.useErrorLog.getState().entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].source, 'ui')
    assert.equal(entries[0].code, 'BAD_REQUEST')
    assert.match(entries[0].message, /Provide either resultId or viewId/)
  })

  it('a bare notification from main is peek itself, not the user', async () => {
    const { notify } = await import('../../state/notifyStore')
    log.startErrorCollection()
    log.clearErrorLog()

    notify('error', 'The driver process exited unexpectedly', 'exit code 1')

    const entries = log.useErrorLog.getState().entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].source, 'system')
    assert.equal(entries[0].code, 'NOTIFY')
    assert.equal(entries[0].detail, 'exit code 1')
  })

  it('an info notification is not a failure and stays out of the error log', async () => {
    const { notify } = await import('../../state/notifyStore')
    log.startErrorCollection()
    log.clearErrorLog()

    notify('info', 'Connected to local')
    assert.equal(
      log.useErrorLog.getState().entries.length,
      0,
      'padding a log with successes stops it being read',
    )

    notify('warn', 'State realigned', 'revision gap')
    assert.equal(log.useErrorLog.getState().entries.length, 1, 'a warning is still worth keeping')
  })
})

/* ------------------------------------------------------------------ *
 * The degraded data plane.
 *
 * When preload's main-world bootstrap fails the control plane still works, so
 * the window looks healthy and every query loads forever. Before this the only
 * trace was a console.error.
 * ------------------------------------------------------------------ */

describe('the degraded data plane announces itself', () => {
  /** Enough of a bridge for `tryBridge` to accept it: invoke + getSnapshot must be functions. */
  function stubBridge(dataPlane: 'ok' | 'degraded'): void {
    const g = globalThis as unknown as Record<string, unknown>
    g['window'] = { peek: { dataPlane, invoke: () => {}, getSnapshot: () => {} } }
  }

  function clearBridge(): void {
    delete (globalThis as unknown as Record<string, unknown>)['window']
  }

  it('reports a degraded bridge as an error the user can see afterwards', () => {
    log.startErrorCollection()
    log.clearErrorLog()
    stubBridge('degraded')
    try {
      log.reportDegradedDataPlane()
    } finally {
      clearBridge()
    }

    const entries = log.useErrorLog.getState().entries
    assert.equal(entries.length, 1, 'a permanently broken data plane must outlive its toast')
    // It goes out through `notify`, not `recordError`: the toast subscription is
    // what files it, so doing both would record the same failure twice.
    assert.equal(entries[0].source, 'system')
    assert.match(entries[0].message, /data channel/)
  })

  it('says nothing when the bridge is healthy', () => {
    log.startErrorCollection()
    log.clearErrorLog()
    stubBridge('ok')
    try {
      log.reportDegradedDataPlane()
    } finally {
      clearBridge()
    }
    assert.equal(log.useErrorLog.getState().entries.length, 0)
  })

  it('the attribution heuristic it replaced is gone, not merely unused', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../error-center/errorLog.ts', import.meta.url), 'utf8')
    // Naming the capability rather than the old identifier: the heuristic needed
    // to know when this window last had a command in flight, and nothing else in
    // this module has any use for that. A differently-named rewrite would still
    // have to reach for it.
    assert.ok(!/useBusyStore|inflight/i.test(src), 'attribution must not depend on in-flight timing again')
  })
})
