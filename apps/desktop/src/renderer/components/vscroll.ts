/* ==================================================================
 * 纵向虚拟滚动驱动器 —— 纵轴彻底脱离 DOM 尺寸。
 *
 * ## 为什么不能用「撑一个 rowCount × ROW_H 高的 spacer」
 *
 * Chromium 单元素布局高度有上限（≈ 2^25 设备像素 / devicePixelRatio：
 * dpr=1 → 33,554,248px，dpr=2 → 16,777,214px，dpr=3 → 11,184,809px）。
 * 90.1 万行 × 24px = 21,624,026px 在 Retina 上被**静默**钳到 16,777,214，
 * 于是最后可见行号只到 694,060，后面 20 万行在界面上永远看不到。
 * 而且这个上限不是常数，写死一个"安全值"在换屏 / 改 zoomFactor 后会再次踩雷。
 *
 * 解法：**DOM 里不存在任何与 rowCount 相关的尺寸**。
 * - `.grid` 改成 `overflow-x:auto; overflow-y:hidden`：横轴仍是原生滚动
 *   （总宽最多几十万 px，离上限差两个数量级，colVirt / sticky 行号栏零改动）；
 * - 纵轴位置只是一个 JS 里的 double `top`（虚拟像素），谁都读不到它的 DOM 尺寸，
 *   所以不存在可被钳位的东西。1 亿行 × 24px = 2.4e9 仍是安全整数。
 *
 * ## 两个精度陷阱（都已绕开）
 *
 * A. 若每帧改每一行的 top，行 props 每帧都变，GridRow 的 memo 整片失效。
 * B. 若把全部位移放到父节点 transform 上，10M 行是 2.4e8 px，
 *    合成器变换矩阵在部分路径是 float32，2.4e8 的 ULP 已经 16px，文字会错位。
 *
 * 解法是**分块原点**：origin = floor(top / ORIGIN_BLOCK_PX) * ORIGIN_BLOCK_PX。
 * - 画布 transform = origin - top，恒在 (-98304, 0]；
 * - 行 top = i*ROW_H - origin + HEAD_H，只在跨 4096 行边界时才变。
 * 于是 DOM 上出现的任何纵向像素量都 < 10 万 px（float32 ULP 0.0078px，无损），
 * 而 memo bail-out 保持在 ~99.98%。
 *
 * ## 这个模块刻意是纯的
 * computeScroll 不碰 DOM，可以在 node:test 里直接对 1M / 10M / 1 亿行断言。
 * ================================================================== */

export const ROW_H = 24
export const HEAD_H = 26
export const ROW_OVERSCAN = 10

/** 分块原点的块大小：4096 行 = 98,304px */
export const ORIGIN_BLOCK_ROWS = 4096
export const ORIGIN_BLOCK_PX = ORIGIN_BLOCK_ROWS * ROW_H

/** 自绘 thumb 的最小高度 */
export const MIN_THUMB_H = 24

export interface ScrollSnapshot {
  /** 纵向偏移（虚拟像素，唯一真源） */
  readonly top: number
  /** 当前分块原点 */
  readonly origin: number
  readonly maxTop: number
  readonly rowCount: number
  /** 表头以下的可视高度 */
  readonly bodyH: number
  /** 要渲染的行区间（含 overscan）；rowCount 为 0 时 renderLast < renderFirst */
  readonly renderFirst: number
  readonly renderLast: number
  /** 真正可见的行区间（上报给 resultCache 做 LRU 保护与 ack 放行） */
  readonly visibleFirst: number
  readonly visibleLast: number
  /** 已贴到可滚动范围末端，再往前推不动了（ack 背压的兜底信号） */
  readonly atBottom: boolean
}

export const EMPTY_SCROLL: ScrollSnapshot = {
  top: 0,
  origin: 0,
  maxTop: 0,
  rowCount: 0,
  bodyH: 0,
  renderFirst: 0,
  renderLast: -1,
  visibleFirst: 0,
  visibleLast: -1,
  atBottom: true,
}

/**
 * 几何计算的**唯一实现**。纯函数，不碰 DOM。
 *
 * @param dpr 设备像素比：把 top 量化到设备像素栅格，避免分数 transform 让等宽字体发虚。
 */
export function computeScroll(
  rowCount: number,
  viewportH: number,
  rawTop: number,
  dpr = 1,
): ScrollSnapshot {
  const rows = Math.max(0, Math.floor(rowCount))
  const bodyH = Math.max(0, viewportH - HEAD_H)
  const maxTop = Math.max(0, rows * ROW_H - bodyH)

  const q = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const raw = Number.isFinite(rawTop) ? rawTop : 0
  const top = Math.min(maxTop, Math.max(0, Math.round(raw * q) / q))

  if (rows === 0) return { ...EMPTY_SCROLL, bodyH, maxTop: 0 }

  const lastRow = rows - 1
  const visibleFirst = Math.min(lastRow, Math.max(0, Math.floor(top / ROW_H)))
  const visibleLast = Math.min(lastRow, Math.max(visibleFirst, Math.ceil((top + bodyH) / ROW_H) - 1))

  return {
    top,
    origin: Math.floor(top / ORIGIN_BLOCK_PX) * ORIGIN_BLOCK_PX,
    maxTop,
    rowCount: rows,
    bodyH,
    renderFirst: Math.max(0, visibleFirst - ROW_OVERSCAN),
    renderLast: Math.min(lastRow, visibleLast + ROW_OVERSCAN),
    visibleFirst,
    visibleLast,
    // 全部内容都装得下（maxTop === 0）也算"推不动了"：能看到的就是全部
    atBottom: maxTop <= 0 || top >= maxTop - 0.5,
  }
}

/** 行 i 在画布坐标系里的 top（画布自身还带一个 origin - top 的 transform） */
export function rowTopIn(index: number, origin: number): number {
  return index * ROW_H + HEAD_H - origin
}

/** 自绘 thumb 的几何。trackH 就是 bodyH。 */
export interface ThumbGeom {
  /** 需要滚动条（内容装不下） */
  readonly visible: boolean
  readonly height: number
  readonly y: number
  /** thumb 可移动的像素行程 */
  readonly travel: number
}

export function thumbGeom(snap: ScrollSnapshot, trackH: number): ThumbGeom {
  const contentH = snap.rowCount * ROW_H
  if (snap.maxTop <= 0 || trackH <= 0 || contentH <= 0) {
    return { visible: false, height: 0, y: 0, travel: 0 }
  }
  const height = Math.max(MIN_THUMB_H, Math.min(trackH, Math.round((trackH * snap.bodyH) / contentH)))
  const travel = Math.max(0, trackH - height)
  return { visible: true, height, y: Math.round((snap.top / snap.maxTop) * travel), travel }
}

export type ViewportSink = (first: number, last: number, atBottom: boolean) => void

/**
 * 驱动器：持有 top，算出快照，直接写 DOM 的两处 transform（画布 + thumb），
 * 只有**行窗口真的移动**时才通知 React 重渲染。
 *
 * 也就是说滚一整屏之内的移动完全不经过 React：一次 style 写入，合成层，无布局无重绘。
 */
export class VScrollDriver {
  /** 行画布；transform = origin - top */
  surface: HTMLElement | null = null
  /** 自绘 thumb；由驱动器直接写 height / transform，不走 React */
  thumb: HTMLElement | null = null
  /**
   * 视口上报口。**同步调用**，不等 React commit——
   * 背压能不能生效因此与渲染时序无关（这是 MINOR 的解法之一）。
   */
  onViewport: ViewportSink | null = null

  private rawTop = 0
  private viewportH = 0
  private rowCount = 0
  private dpr = 1
  /**
   * **DOM 里那批行当前用的分块原点**，由渲染层在 React 提交之后回写。
   *
   * 画布 transform 必须配这个值，而不是配 `snap.origin`：跨 4096 行边界那一刻，
   * snap.origin 立刻变了，但 DOM 里的行还带着旧 origin（React 要到下一次提交才换）。
   * 若此时就按新 origin 写 transform，两者会错开整整一个块（98,304px）——
   * 屏幕上是一帧全白。改用 domOrigin 之后，transform 与行 top 永远出自同一个原点：
   * React 迟一帧提交最多让画面停一帧，绝不会错位。
   */
  private domOrigin = 0
  private snap: ScrollSnapshot = EMPTY_SCROLL
  /** useSyncExternalStore 读的那份：只在通知时换新引用，绝不撕裂 */
  private viewSnap: ScrollSnapshot = EMPTY_SCROLL
  private readonly subs = new Set<() => void>()

  getSnapshot = (): ScrollSnapshot => this.viewSnap

  subscribe = (cb: () => void): (() => void) => {
    this.subs.add(cb)
    return (): void => {
      this.subs.delete(cb)
    }
  }

  /** 当前几何（命令式读取，给事件处理器用） */
  get metrics(): ScrollSnapshot {
    return this.snap
  }

  get maxTop(): number {
    return this.snap.maxTop
  }

  setGeometry(viewportH: number, rowCount: number, dpr: number): void {
    if (viewportH === this.viewportH && rowCount === this.rowCount && dpr === this.dpr) return
    this.viewportH = viewportH
    this.rowCount = rowCount
    this.dpr = dpr
    // rawTop 不动 ⇒ 流式追加时用户视线锁在同一行，内容不会在眼皮底下往前漂
    this.commit(this.rawTop, true)
  }

  scrollTo(px: number): void {
    this.commit(px, false)
  }

  scrollBy(dy: number): void {
    this.commit(this.rawTop + dy, false)
  }

  /** 跳到某一行；任意行数下都精确（这是自绘相对原生滚动的关键增益） */
  scrollToRow(index: number, align: 'start' | 'center' = 'start'): void {
    const base = index * ROW_H
    this.commit(align === 'center' ? base - (this.snap.bodyH - ROW_H) / 2 : base, false)
  }

  /** 换结果集：位置归零 */
  reset(): void {
    this.rawTop = 0
    this.commit(0, true)
  }

  /**
   * 渲染层回写"这一批行是按哪个原点排的"。
   * 必须在 React 提交之后调（useLayoutEffect），且只能传本次渲染用的那个 origin。
   */
  syncDomOrigin(origin: number): void {
    if (this.domOrigin === origin) return
    this.domOrigin = origin
    this.paint()
  }

  /** 当前画布 transform 所依据的原点（测试与断言用） */
  get paintedOrigin(): number {
    return this.domOrigin
  }

  /** 挂上 DOM 之后补一次绘制（React ref 回调时机晚于 commit） */
  paint(): void {
    const { surface, thumb, snap } = this
    // 注意是 domOrigin 不是 snap.origin，理由见 domOrigin 的注释
    if (surface) surface.style.transform = `translate3d(0,${this.domOrigin - snap.top}px,0)`
    if (thumb) {
      const g = thumbGeom(snap, snap.bodyH)
      thumb.style.display = g.visible ? '' : 'none'
      thumb.style.height = `${g.height}px`
      thumb.style.transform = `translate3d(0,${g.y}px,0)`
    }
  }

  private commit(next: number, force: boolean): void {
    const prev = this.snap
    const snap = computeScroll(this.rowCount, this.viewportH, next, this.dpr)
    if (!force && snap.top === prev.top && snap.rowCount === prev.rowCount
      && snap.bodyH === prev.bodyH) {
      return
    }
    this.snap = snap
    // 位置永远存 clamp 之后的值：fling 到底时不许把过冲量攒起来，
    // 否则用户要反向空滚一大段才看得到内容动
    this.rawTop = snap.top

    // 视口同步上报：ack 放行 / LRU 保护不等 React
    if (snap.visibleLast >= snap.visibleFirst) {
      this.onViewport?.(snap.visibleFirst, snap.visibleLast, snap.atBottom)
    }

    this.paint()

    // 行窗口没动就不打扰 React：滚动一整屏之内只有上面那两次 style 写入
    if (
      snap.renderFirst !== prev.renderFirst
      || snap.renderLast !== prev.renderLast
      || snap.origin !== prev.origin
      || snap.rowCount !== prev.rowCount
      || snap.maxTop !== prev.maxTop
    ) {
      // viewSnap 与通知必须成对：useSyncExternalStore 的 getSnapshot 只能在
      // 收到通知之后才换新引用，否则 React 会判定为撕裂
      this.viewSnap = snap
      for (const cb of [...this.subs]) cb()
    }
  }
}
