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
 * BLOCKER 1 的回归网。
 *
 * 旧实现用 `rowCount × ROW_H` 当 DOM 高度撑滚动条，Chromium 把它静默钳到
 * ~2^25/dpr 设备像素（Retina 上 16,777,214px），于是 699,050 行之后的数据
 * 在界面上永远看不到。现在纵轴几何完全活在 JS 里，这组用例把
 * "第 N 行必须能被算到、最后一行必须能贴底" 钉死在纯函数上。
 * ================================================================== */

/** 旧实现的可达上限：Retina 下 16,777,214px / 24px ≈ 699,050 行 */
const LEGACY_CLAMP_PX = 16_777_214
const LEGACY_REACHABLE_ROWS = Math.floor(LEGACY_CLAMP_PX / ROW_H)

/** 一个典型视口：668px 高（探针实测值），表头之下 642px ≈ 26.75 行 */
const VIEWPORT_H = 668

describe('computeScroll —— 超大行数的行号映射', () => {
  const cases = [
    { label: '100 万行', rows: 1_000_000 },
    { label: '1000 万行', rows: 10_000_000 },
    { label: '1 亿行', rows: 100_000_000 },
  ]

  for (const c of cases) {
    it(`${c.label}：滚到底能看到最后一行，且末行底边与容器底边严丝合缝`, () => {
      const bodyH = VIEWPORT_H - HEAD_H
      const s = computeScroll(c.rows, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)

      assert.equal(s.maxTop, c.rows * ROW_H - bodyH)
      assert.equal(s.top, s.maxTop, 'clamp 到 maxTop，不多不少')
      assert.equal(s.visibleLast, c.rows - 1, '最后一行必须在可见区间里')
      assert.equal(s.renderLast, c.rows - 1)
      assert.equal(s.atBottom, true)

      // 末行底边 = 行号 × 行高 - 滚动量 + 表头高，相对容器顶部
      const lastRowBottom = c.rows * ROW_H - s.top + HEAD_H
      assert.equal(lastRowBottom, VIEWPORT_H, '末行底边正好落在容器底边上')
    })

    it(`${c.label}：任意行都能被精确定位（含旧实现够不到的那一段）`, () => {
      const probes = [0, 1, LEGACY_REACHABLE_ROWS - 1, LEGACY_REACHABLE_ROWS + 1, c.rows - 1]
      for (const target of probes) {
        if (target < 0 || target >= c.rows) continue
        const s = computeScroll(c.rows, VIEWPORT_H, target * ROW_H, 2)
        // 无论目标行落在哪，它都必须真的进入可见区间
        assert.ok(
          target >= s.visibleFirst && target <= s.visibleLast,
          `第 ${target} 行没进可见区间 [${s.visibleFirst}, ${s.visibleLast}]`,
        )
        // 该行在画布坐标系里的位置 + 画布位移 = 它相对容器顶部的真实 y
        const y = rowTopIn(target, s.origin) + (s.origin - s.top)
        if (target * ROW_H <= s.maxTop) {
          assert.equal(s.visibleFirst, target, `第 ${target} 行应当顶到表头下沿`)
          assert.equal(y, HEAD_H)
        } else {
          // 末尾那几行顶不上去（已经到底了），但必须完整落在视口内
          assert.ok(y >= HEAD_H && y + ROW_H <= VIEWPORT_H + 0.5, `第 ${target} 行的 y=${y} 越界`)
        }
      }
    })
  }

  it('对照：旧实现的 16,777,214px 钳位会让 699,051 行之后彻底不可达', () => {
    // 这条不是断言新代码，而是把"为什么要改"钉在测试里：
    // 用旧口径（scrollTop 上限 = 钳位高度 - 视口）算，90.1 万行只能滚到 69.4 万
    const rows = 901_000
    const legacyMaxScrollTop = LEGACY_CLAMP_PX - VIEWPORT_H
    const legacyLastVisible = Math.floor((legacyMaxScrollTop + VIEWPORT_H - HEAD_H) / ROW_H) - 1
    assert.ok(legacyLastVisible < 700_000, '旧实现连 70 万行都到不了')
    assert.ok(rows - legacyLastVisible > 200_000, '够不到的行数超过 AHEAD_ROWS，必然把 ack 饿死')

    // 新实现：同样 90.1 万行，最后一行可达
    const s = computeScroll(rows, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    assert.equal(s.visibleLast, rows - 1)
    assert.equal(rows - 1 - s.visibleLast, 0)
  })
})

describe('computeScroll —— 分块原点（合成器 float32 精度的防线）', () => {
  it('DOM 上出现的纵向像素量在任何行数下都 < 10 万', () => {
    for (const rows of [1_000_000, 10_000_000, 100_000_000]) {
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        const s = computeScroll(rows, VIEWPORT_H, (rows * ROW_H - 642) * frac, 2)
        const surfaceShift = Math.abs(s.origin - s.top)
        assert.ok(surfaceShift < ORIGIN_BLOCK_PX, `画布位移 ${surfaceShift} 越界`)
        for (const i of [s.renderFirst, s.renderLast]) {
          assert.ok(Math.abs(rowTopIn(i, s.origin)) < 100_000, `行 top ${rowTopIn(i, s.origin)} 越界`)
        }
      }
    }
  })

  it('origin 只在跨 4096 行边界时变化 ⇒ 行 props 几乎恒定，memo 不失效', () => {
    const base = computeScroll(1_000_000, VIEWPORT_H, 500_000 * ROW_H, 2)
    let changes = 0
    let prev = base.origin
    // 连续滚过 4096 行，只允许换一次原点
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

describe('分块原点：画布位移必须与 DOM 里那批行同源', () => {
  /** 假的 surface：只要有 style.transform 就够，驱动器不读别的 */
  function fakeSurface(): { style: { transform: string } } {
    return { style: { transform: '' } }
  }
  const shiftOf = (s: { style: { transform: string } }): number =>
    Number(/translate3d\(0,(-?[\d.]+)px,0\)/.exec(s.style.transform)?.[1] ?? NaN)

  /** 行 i 画在屏幕上的 y = 它的 top prop（按 DOM 原点算） + 画布位移 */
  const screenY = (i: number, domOrigin: number, shift: number): number =>
    rowTopIn(i, domOrigin) + shift

  it('React 还没提交新原点时，画布仍按旧原点位移 ⇒ 画面最多停一帧，绝不错位', () => {
    const driver = new VScrollDriver()
    const surface = fakeSurface()
    driver.surface = surface as unknown as HTMLElement
    driver.setGeometry(VIEWPORT_H, 1_000_000, 2)

    // 停在第一个分块边界前 100px，此时 React 已经把 origin=0 的那批行提交了
    driver.scrollTo(ORIGIN_BLOCK_PX - 100)
    driver.syncDomOrigin(driver.metrics.origin)
    const domOrigin = driver.paintedOrigin
    assert.equal(domOrigin, 0)

    // 跨过边界：驱动器算出的新原点是 98304，但 DOM 里的行还是按 0 排的
    driver.scrollTo(ORIGIN_BLOCK_PX + 100)
    assert.equal(driver.metrics.origin, ORIGIN_BLOCK_PX, '几何上原点确实换了')
    assert.equal(driver.paintedOrigin, 0, '但画布仍按 DOM 现有的原点走')

    const shift = shiftOf(surface)
    assert.equal(shift, domOrigin - driver.metrics.top)
    // 关键断言：DOM 里现存的行画在屏幕上的位置依旧完全正确
    for (const i of [driver.metrics.renderFirst, driver.metrics.renderLast]) {
      assert.equal(
        screenY(i, domOrigin, shift),
        i * ROW_H + HEAD_H - driver.metrics.top,
        '行的屏幕坐标必须与滚动量严格一致',
      )
    }
    // 若当初按 snap.origin 写 transform，这里会错开整整一个分块
    assert.equal(Math.abs((driver.metrics.origin - driver.metrics.top) - shift), ORIGIN_BLOCK_PX)

    // React 提交之后回写新原点，屏幕坐标仍然正确（只是换了个基准）
    driver.syncDomOrigin(driver.metrics.origin)
    const shift2 = shiftOf(surface)
    for (const i of [driver.metrics.renderFirst, driver.metrics.renderLast]) {
      assert.equal(
        screenY(i, driver.paintedOrigin, shift2),
        i * ROW_H + HEAD_H - driver.metrics.top,
      )
    }
  })

  it('无论提交时机如何交错，屏幕坐标恒等于 i*ROW_H + HEAD_H - top', () => {
    const driver = new VScrollDriver()
    const surface = fakeSurface()
    driver.surface = surface as unknown as HTMLElement
    driver.setGeometry(VIEWPORT_H, 10_000_000, 2)

    let committed = driver.metrics.origin
    driver.syncDomOrigin(committed)
    // 每次滚一段，模拟"React 有时当帧提交、有时迟一帧"
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

describe('computeScroll —— 边界', () => {
  it('空结果集不产生可见区间', () => {
    const s = computeScroll(0, VIEWPORT_H, 0, 2)
    assert.equal(s.rowCount, 0)
    assert.ok(s.renderLast < s.renderFirst, '没有行可渲染')
    assert.equal(s.maxTop, 0)
    assert.equal(s.atBottom, true)
  })

  it('内容装得下时 maxTop=0 且恒为 atBottom（视口物理上推不动了）', () => {
    const s = computeScroll(5, VIEWPORT_H, 0, 2)
    assert.equal(s.maxTop, 0)
    assert.equal(s.atBottom, true)
    assert.equal(s.visibleLast, 4)
  })

  it('负值与越界输入都被夹住，不会算出负行号', () => {
    const lo = computeScroll(1_000, VIEWPORT_H, -99_999, 2)
    assert.equal(lo.top, 0)
    assert.equal(lo.visibleFirst, 0)
    const hi = computeScroll(1_000, VIEWPORT_H, 1e18, 2)
    assert.equal(hi.top, hi.maxTop)
    assert.equal(hi.visibleLast, 999)
    const nan = computeScroll(1_000, VIEWPORT_H, Number.NaN, 2)
    assert.equal(nan.top, 0)
  })

  it('top 量化到设备像素栅格（分数 transform 会让等宽字体发虚）', () => {
    assert.equal(computeScroll(1_000, VIEWPORT_H, 10.3, 2).top, 10.5)
    assert.equal(computeScroll(1_000, VIEWPORT_H, 10.3, 1).top, 10)
  })

  it('overscan 只向外扩，不越过两端', () => {
    const top = computeScroll(1_000_000, VIEWPORT_H, 0, 2)
    assert.equal(top.renderFirst, 0)
    const bottom = computeScroll(1_000_000, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    assert.equal(bottom.renderLast, 999_999)
    assert.equal(bottom.renderFirst, bottom.visibleFirst - ROW_OVERSCAN)
  })
})

describe('thumbGeom —— 自绘滚动条不说谎', () => {
  it('拖到底 ⇒ thumb 贴底；内容装得下 ⇒ 不显示', () => {
    const bodyH = VIEWPORT_H - HEAD_H
    const bottom = computeScroll(1_000_000, VIEWPORT_H, Number.MAX_SAFE_INTEGER, 2)
    const g = thumbGeom(bottom, bodyH)
    assert.equal(g.visible, true)
    assert.equal(g.y, g.travel, 'thumb 走到行程末端')
    assert.ok(g.height >= 24, '最小高度兜底')

    const tiny = computeScroll(3, VIEWPORT_H, 0, 2)
    assert.equal(thumbGeom(tiny, bodyH).visible, false)
  })
})

describe('VScrollDriver —— 视口上报与 React 通知', () => {
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

  it('视口在 setGeometry 时就同步上报，不等 React commit', () => {
    const { seen } = makeDriver(1_000_000)
    assert.equal(seen.length, 1, '几何一确定就上报了')
    assert.deepEqual(seen[0], { first: 0, last: 26, atBottom: false })
  })

  it('滚到底：viewport.end 抵达 rowCount-1 且 atBottom=true（BLOCKER 2 的前提）', () => {
    const { driver, seen } = makeDriver(1_000_000)
    driver.scrollTo(driver.maxTop)
    const last = seen[seen.length - 1]
    assert.equal(last.last, 999_999)
    assert.equal(last.atBottom, true)
    assert.equal(1_000_000 - last.last, 1, '视口前方只剩 1 行，行数背压规则永不触发')
  })

  it('scrollToRow 在任意行数下精确到行', () => {
    const { driver, seen } = makeDriver(10_000_000)
    driver.scrollToRow(9_876_543)
    assert.equal(seen[seen.length - 1].first, 9_876_543)
    assert.equal(driver.metrics.top, 9_876_543 * ROW_H)
  })

  it('行数增长时位置不动 ⇒ 流式追加不会让内容在眼皮底下漂', () => {
    const driver = new VScrollDriver()
    driver.setGeometry(VIEWPORT_H, 300_000, 2)
    driver.scrollToRow(150_000)
    const before = driver.metrics.top
    driver.setGeometry(VIEWPORT_H, 900_000, 2)
    assert.equal(driver.metrics.top, before)
    assert.equal(driver.metrics.visibleFirst, 150_000)
  })

  it('窗口内的小幅滚动不通知 React（每帧只有两次 style 写入）', () => {
    const h = makeDriver(1_000_000)
    const before = h.notifies
    // 一个行高之内来回蹭：渲染窗口不变
    h.driver.scrollBy(1)
    h.driver.scrollBy(1)
    h.driver.scrollBy(-1)
    assert.equal(h.notifies, before, '行窗口没动就不打扰 React')
    // 越过一整行：窗口移动，必须通知
    h.driver.scrollBy(ROW_H * 2)
    assert.ok(h.notifies > before)
  })

  it('reset 把位置归零（换结果集绝不能停在上一份数据的滚动位置）', () => {
    const { driver } = makeDriver(1_000_000)
    driver.scrollTo(driver.maxTop)
    driver.reset()
    assert.equal(driver.metrics.top, 0)
    assert.equal(driver.metrics.visibleFirst, 0)
  })

  it('EMPTY_SCROLL 是安全初值：没有可渲染行、atBottom 为真', () => {
    assert.ok(EMPTY_SCROLL.renderLast < EMPTY_SCROLL.renderFirst)
    assert.equal(EMPTY_SCROLL.atBottom, true)
  })
})
