import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  EMPTY_SCROLL,
  HEAD_H,
  ORIGIN_BLOCK_PX,
  ROW_H,
  ROW_OVERSCAN,
  VScrollDriver,
  computeScroll,
  rowTopIn,
  thumbGeom,
} from '../vscroll'

/* ==================================================================
 * The regression net for BLOCKER 1.
 *
 * The old implementation gave the scroll container a DOM height of
 * `rowCount × ROW_H`, which Chromium silently clamps at ~2^25/dpr device pixels
 * (16,777,214px on Retina) — so anything past row 699,050 could never be seen.
 * The vertical geometry now lives entirely in JS, and these cases pin "row N can
 * always be addressed, and the last row can always reach the bottom" onto a pure
 * function.
 * ================================================================== */

/** The old ceiling: 16,777,214px / 24px ≈ 699,050 rows on Retina. */
const LEGACY_CLAMP_PX = 16_777_214
const LEGACY_REACHABLE_ROWS = Math.floor(LEGACY_CLAMP_PX / ROW_H)

/** A typical viewport: 668px tall (measured), 642px below the header ≈ 26.75 rows. */
const VIEWPORT_H = 668

describe('computeScroll — row mapping at very large row counts', () => {
  const cases = [
    { label: '1M rows', rows: 1_000_000 },
    { label: '10M rows', rows: 10_000_000 },
    { label: '100M rows', rows: 100_000_000 },
  ]

  for (const c of cases) {
    it(`${c.label}: scrolled to the end, the last row is visible and flush with the bottom`, () => {
      const bodyH = VIEWPORT_H - HEAD_H
      const s = computeScroll(c.rows, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)

      assert.equal(s.maxTop, c.rows * ROW_H - bodyH)
      assert.equal(s.top, s.maxTop, 'clamped to maxTop, no more and no less')
      assert.equal(s.visibleLast, c.rows - 1, 'the last row has to be inside the visible range')
      assert.equal(s.renderLast, c.rows - 1)
      assert.equal(s.atBottom, true)

      // Bottom of the last row, relative to the container top:
      // row index × row height - scroll offset + header height
      const lastRowBottom = c.rows * ROW_H - s.top + HEAD_H
      assert.equal(lastRowBottom, VIEWPORT_H, "the last row's bottom lands exactly on the container's")
    })

    it(`${c.label}: any row can be addressed exactly, including the range the old code could not reach`, () => {
      const probes = [0, 1, LEGACY_REACHABLE_ROWS - 1, LEGACY_REACHABLE_ROWS + 1, c.rows - 1]
      for (const target of probes) {
        if (target < 0 || target >= c.rows) continue
        const s = computeScroll(c.rows, VIEWPORT_H, target * ROW_H, 2)
        // Wherever the target row falls, it must genuinely enter the visible range
        assert.ok(
          target >= s.visibleFirst && target <= s.visibleLast,
          `row ${target} is outside the visible range [${s.visibleFirst}, ${s.visibleLast}]`,
        )
        // Position in surface coordinates + surface shift = the row's real y
        // relative to the container top
        const y = rowTopIn(target, s.origin) + (s.origin - s.top)
        if (target * ROW_H <= s.maxTop) {
          assert.equal(s.visibleFirst, target, `row ${target} should sit right under the header`)
          assert.equal(y, HEAD_H)
        } else {
          // The last few rows cannot reach the top (we are already at the end),
          // but they must still fall entirely inside the viewport
          assert.ok(y >= HEAD_H && y + ROW_H <= VIEWPORT_H + 0.5, `row ${target} has y=${y}, out of bounds`)
        }
      }
    })
  }

  it('for contrast: the old 16,777,214px clamp made everything past row 699,051 unreachable', () => {
    // This asserts nothing about the new code; it pins *why the change happened*
    // into the suite. Measured the old way (max scrollTop = clamped height minus
    // viewport), 901k rows could only be scrolled to about 694k.
    const rows = 901_000
    const legacyMaxScrollTop = LEGACY_CLAMP_PX - VIEWPORT_H
    const legacyLastVisible = Math.floor((legacyMaxScrollTop + VIEWPORT_H - HEAD_H) / ROW_H) - 1
    assert.ok(legacyLastVisible < 700_000, 'the old implementation could not even reach row 700,000')
    assert.ok(
      rows - legacyLastVisible > 200_000,
      'more unreachable rows than AHEAD_ROWS, so the ack was bound to starve',
    )

    // The new implementation: same 901k rows, last row reachable
    const s = computeScroll(rows, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    assert.equal(s.visibleLast, rows - 1)
    assert.equal(rows - 1 - s.visibleLast, 0)
  })
})

describe('computeScroll — the block origin, guarding against float32 in the compositor', () => {
  it('every vertical pixel quantity in the DOM stays under 100k at any row count', () => {
    for (const rows of [1_000_000, 10_000_000, 100_000_000]) {
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const s = computeScroll(rows, VIEWPORT_H, (rows * ROW_H - 642) * frac, 2)
        const surfaceShift = Math.abs(s.origin - s.top)
        assert.ok(surfaceShift < ORIGIN_BLOCK_PX, `surface shift ${surfaceShift} is out of bounds`)
        for (const i of [s.renderFirst, s.renderLast]) {
          assert.ok(
            Math.abs(rowTopIn(i, s.origin)) < 100_000,
            `row top ${rowTopIn(i, s.origin)} is out of bounds`,
          )
        }
      }
    }
  })

  it('the origin only changes across a 4096-row boundary, so row props stay constant and memo holds', () => {
    const base = computeScroll(1_000_000, VIEWPORT_H, 500_000 * ROW_H, 2)
    let changes = 0
    let prev = base.origin
    // Scrolling continuously across 4096 rows may change the origin exactly once
    for (let d = 0; d <= ORIGIN_BLOCK_PX; d += ROW_H) {
      const s = computeScroll(1_000_000, VIEWPORT_H, 500_000 * ROW_H + d, 2)
      if (s.origin !== prev) {
        changes += 1
        prev = s.origin
      }
    }
    assert.equal(changes, 1)
  })
})

describe('block origin: the surface shift must share an origin with the rows in the DOM', () => {
  /** A fake surface: style.transform is all the driver ever reads. */
  function fakeSurface(): { style: { transform: string } } {
    return { style: { transform: '' } }
  }
  const shiftOf = (s: { style: { transform: string } }): number =>
    Number(/translate3d\(0,(-?[\d.]+)px,0\)/.exec(s.style.transform)?.[1] ?? NaN)

  /** Screen y of row i = its top prop (against the DOM origin) + the surface shift. */
  const screenY = (i: number, domOrigin: number, shift: number): number => rowTopIn(i, domOrigin) + shift

  it('before React commits the new origin the surface keeps the old one: at most a stalled frame, never a misplaced one', () => {
    const driver = new VScrollDriver()
    const surface = fakeSurface()
    driver.surface = surface as unknown as HTMLElement
    driver.setGeometry(VIEWPORT_H, 1_000_000, 2)

    // Sit 100px before the first block boundary; React has already committed the
    // batch of rows laid out against origin=0
    driver.scrollTo(ORIGIN_BLOCK_PX - 100)
    driver.syncDomOrigin(driver.metrics.origin)
    const domOrigin = driver.paintedOrigin
    assert.equal(domOrigin, 0)

    // Cross the boundary: the driver computes a new origin of 98304, but the rows
    // in the DOM are still laid out against 0
    driver.scrollTo(ORIGIN_BLOCK_PX + 100)
    assert.equal(driver.metrics.origin, ORIGIN_BLOCK_PX, 'geometrically the origin really did change')
    assert.equal(driver.paintedOrigin, 0, 'but the surface still follows the origin the DOM has')

    const shift = shiftOf(surface)
    assert.equal(shift, domOrigin - driver.metrics.top)
    // The key assertion: the rows currently in the DOM are still painted in exactly
    // the right place
    for (const i of [driver.metrics.renderFirst, driver.metrics.renderLast]) {
      assert.equal(
        screenY(i, domOrigin, shift),
        i * ROW_H + HEAD_H - driver.metrics.top,
        "a row's screen coordinate must agree exactly with the scroll offset",
      )
    }
    // Had the transform been written against snap.origin, this would be off by a
    // full block
    assert.equal(Math.abs(driver.metrics.origin - driver.metrics.top - shift), ORIGIN_BLOCK_PX)

    // After React commits, report the new origin; the screen coordinates stay
    // correct, only the reference point moved
    driver.syncDomOrigin(driver.metrics.origin)
    const shift2 = shiftOf(surface)
    for (const i of [driver.metrics.renderFirst, driver.metrics.renderLast]) {
      assert.equal(screenY(i, driver.paintedOrigin, shift2), i * ROW_H + HEAD_H - driver.metrics.top)
    }
  })

  it('however commits interleave, a screen coordinate is always i*ROW_H + HEAD_H - top', () => {
    const driver = new VScrollDriver()
    const surface = fakeSurface()
    driver.surface = surface as unknown as HTMLElement
    driver.setGeometry(VIEWPORT_H, 10_000_000, 2)

    let committed = driver.metrics.origin
    driver.syncDomOrigin(committed)
    // Scroll a stretch at a time, simulating React committing on this frame
    // sometimes and one frame late at others
    for (let step = 0; step < 60; step += 1) {
      driver.scrollBy(ORIGIN_BLOCK_PX / 3 + step)
      const m = driver.metrics
      const shift = shiftOf(surface)
      for (const i of [m.renderFirst, m.visibleFirst, m.renderLast]) {
        assert.equal(screenY(i, committed, shift), i * ROW_H + HEAD_H - m.top)
      }
      if (step % 2 === 0) {
        committed = m.origin
        driver.syncDomOrigin(committed)
      }
    }
  })
})

describe('computeScroll — edge cases', () => {
  it('an empty result set produces no visible range', () => {
    const s = computeScroll(0, VIEWPORT_H, 0, 2)
    assert.equal(s.rowCount, 0)
    assert.ok(s.renderLast < s.renderFirst, 'there is no row to render')
    assert.equal(s.maxTop, 0)
    assert.equal(s.atBottom, true)
  })

  it('content that fits gives maxTop=0 and a permanent atBottom (the viewport physically cannot advance)', () => {
    const s = computeScroll(5, VIEWPORT_H, 0, 2)
    assert.equal(s.maxTop, 0)
    assert.equal(s.atBottom, true)
    assert.equal(s.visibleLast, 4)
  })

  it('negative and out-of-range input is clamped, never yielding a negative row index', () => {
    const lo = computeScroll(1_000, VIEWPORT_H, -99_999, 2)
    assert.equal(lo.top, 0)
    assert.equal(lo.visibleFirst, 0)
    const hi = computeScroll(1_000, VIEWPORT_H, 1e18, 2)
    assert.equal(hi.top, hi.maxTop)
    assert.equal(hi.visibleLast, 999)
    const nan = computeScroll(1_000, VIEWPORT_H, Number.NaN, 2)
    assert.equal(nan.top, 0)
  })

  it('top is quantized onto the device pixel grid (a fractional transform blurs monospace text)', () => {
    assert.equal(computeScroll(1_000, VIEWPORT_H, 10.3, 2).top, 10.5)
    assert.equal(computeScroll(1_000, VIEWPORT_H, 10.3, 1).top, 10)
  })

  it('overscan only expands outwards and never runs past either end', () => {
    const top = computeScroll(1_000_000, VIEWPORT_H, 0, 2)
    assert.equal(top.renderFirst, 0)
    const bottom = computeScroll(1_000_000, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    assert.equal(bottom.renderLast, 999_999)
    assert.equal(bottom.renderFirst, bottom.visibleFirst - ROW_OVERSCAN)
  })
})

describe('thumbGeom — the hand-drawn scrollbar does not lie', () => {
  it('dragged to the end the thumb sits at the end; content that fits shows no thumb', () => {
    const bodyH = VIEWPORT_H - HEAD_H
    const bottom = computeScroll(1_000_000, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    const g = thumbGeom(bottom, bodyH)
    assert.equal(g.visible, true)
    assert.equal(g.y, g.travel, 'the thumb reached the end of its travel')
    assert.ok(g.height >= 24, 'the minimum height still applies')

    const tiny = computeScroll(3, VIEWPORT_H, 0, 2)
    assert.equal(thumbGeom(tiny, bodyH).visible, false)
  })
})

describe('VScrollDriver — viewport reporting and React notification', () => {
  function makeDriver(rows: number): {
    driver: VScrollDriver
    seen: { first: number; last: number; atBottom: boolean }[]
    notifies: number
  } {
    const driver = new VScrollDriver()
    const seen: { first: number; last: number; atBottom: boolean }[] = []
    const state = { notifies: 0 }
    driver.onViewport = (first, last, atBottom): void => {
      seen.push({ first, last, atBottom })
    }
    driver.subscribe(() => {
      state.notifies += 1
    })
    driver.setGeometry(VIEWPORT_H, rows, 2)
    return {
      driver,
      seen,
      get notifies(): number {
        return state.notifies
      },
    }
  }

  it('the viewport is reported synchronously from setGeometry, without waiting for a React commit', () => {
    const { seen } = makeDriver(1_000_000)
    assert.equal(seen.length, 1, 'reported as soon as the geometry was known')
    assert.deepEqual(seen[0], { first: 0, last: 26, atBottom: false })
  })

  it('scrolled to the end: viewport.end reaches rowCount-1 with atBottom=true (the premise of BLOCKER 2)', () => {
    const { driver, seen } = makeDriver(1_000_000)
    driver.scrollTo(driver.maxTop)
    const last = seen[seen.length - 1]
    assert.equal(last.last, 999_999)
    assert.equal(last.atBottom, true)
    assert.equal(
      1_000_000 - last.last,
      1,
      'one row left ahead of the viewport, so the row-count rule can never trip',
    )
  })

  it('scrollToRow is row-exact at any row count', () => {
    const { driver, seen } = makeDriver(10_000_000)
    driver.scrollToRow(9_876_543)
    assert.equal(seen[seen.length - 1].first, 9_876_543)
    assert.equal(driver.metrics.top, 9_876_543 * ROW_H)
  })

  it('a growing row count leaves the position alone, so streaming rows do not drift under the reader', () => {
    const driver = new VScrollDriver()
    driver.setGeometry(VIEWPORT_H, 300_000, 2)
    driver.scrollToRow(150_000)
    const before = driver.metrics.top
    driver.setGeometry(VIEWPORT_H, 900_000, 2)
    assert.equal(driver.metrics.top, before)
    assert.equal(driver.metrics.visibleFirst, 150_000)
  })

  it('small movements within the window do not notify React (two style writes per frame, nothing else)', () => {
    const h = makeDriver(1_000_000)
    const before = h.notifies
    // Nudging back and forth within a single row height: the render window holds
    h.driver.scrollBy(1)
    h.driver.scrollBy(1)
    h.driver.scrollBy(-1)
    assert.equal(h.notifies, before, 'the row window did not move, so React was left alone')
    // Cross a whole row: the window moves and a notification is mandatory
    h.driver.scrollBy(ROW_H * 2)
    assert.ok(h.notifies > before)
  })

  it('reset returns to the top (a new result set must never inherit the old scroll position)', () => {
    const { driver } = makeDriver(1_000_000)
    driver.scrollTo(driver.maxTop)
    driver.reset()
    assert.equal(driver.metrics.top, 0)
    assert.equal(driver.metrics.visibleFirst, 0)
  })

  it('EMPTY_SCROLL is a safe initial value: nothing to render, atBottom true', () => {
    assert.ok(EMPTY_SCROLL.renderLast < EMPTY_SCROLL.renderFirst)
    assert.equal(EMPTY_SCROLL.atBottom, true)
  })
})
