import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/* ==================================================================
 * 表格浮层的**结构不变量**回归网。
 *
 * 事故本体：`.grid` 从双轴滚动改成「横轴原生滚动 + 纵轴自绘」之后，自绘滚动条
 * 仍然渲染在 `.grid` 内部。横向滚动容器的 absolute 后代属于"可滚动内容"，
 * 会随 scrollLeft 一起平移，再叠加 `.grid` 的 contain:layout paint 一裁，
 * **表格一横向滚动，唯一的纵向滚动条连同拖拽跳转 / 行号气泡 / Shift 精调一起消失且点不到**。
 * 触发条件是 totalWidth > 面板宽 —— 对 DB viewer 是常态。
 *
 * 真几何只有真浏览器算得出来（node 里没有布局），所以这里守的是**因果链的上游**：
 * 谁是谁的后代。Electron 43 里对同一份 styles.css 实测过两种结构的差别：
 *   挂 .grid-wrap（现结构）：scrollLeft 0 / 1000 / 2154 → vsb.right - grid.right 恒为 0，
 *                            elementFromPoint(thumb 中心) 恒为 grid-vsb-thumb；
 *   挂 .grid  （旧结构）  ：同样三档 → 差值 0 / -1000 / -2154，命中测试恒为 null。
 * 结构一旦被改回去，下面的断言立刻红；几何差异照旧交给真机验收去量。
 * ================================================================== */

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const GRID_TSX = src('../DataGrid.tsx')
const CSS = src('../../styles.css')

const sf = ts.createSourceFile('DataGrid.tsx', GRID_TSX, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement

function tagName(node: JsxNode): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.tagName.getText(sf)
}

/** className="literal"（本文件里的浮层节点全是字面量，动态类名不在讨论范围内） */
function className(node: JsxNode): string | null {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  for (const attr of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'className') continue
    const init = attr.initializer
    if (init && ts.isStringLiteral(init)) return init.text
  }
  return null
}

function collect(root: ts.Node): JsxNode[] {
  const out: JsxNode[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) out.push(n)
    n.forEachChild(walk)
  }
  walk(root)
  return out
}

const all = collect(sf)

function byClass(nodes: JsxNode[], cls: string): JsxNode | undefined {
  return nodes.find((n) => className(n) === cls)
}

function byTag(nodes: JsxNode[], tag: string): JsxNode | undefined {
  return nodes.find((n) => tagName(n) === tag)
}

/** 某个 CSS 选择器的声明块正文 */
function cssBlock(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`)
  assert.notEqual(i, -1, `styles.css 里找不到 ${selector}`)
  const start = CSS.indexOf('{', i)
  const end = CSS.indexOf('}', start)
  return CSS.slice(start + 1, end)
}

describe('自绘滚动条与覆盖层不能是横向滚动容器的后代', () => {
  const wrap = byClass(all, 'grid-wrap')
  const grid = byClass(all, 'grid')

  it('DataGrid 里 .grid-wrap 与 .grid 都在，且 .grid 挂在 .grid-wrap 下', () => {
    assert.ok(wrap, '.grid-wrap 不见了：浮层就失去了不滚动的锚点')
    assert.ok(grid, '.grid 不见了')
    assert.ok(collect(wrap!).includes(grid!), '.grid 必须在 .grid-wrap 内部')
  })

  it('<GridScrollbar> 是 .grid 的兄弟而不是后代（横向滚动时不许跟着滑走）', () => {
    // 断言用 ok(!x) 而不是 equal(x, undefined)：失败时不去 diff 整棵 AST
    assert.ok(
      !byTag(collect(grid!), 'GridScrollbar'),
      '滚动条一旦回到 .grid 内部，横向一滚就整个滑出可视区且点不到',
    )
    assert.ok(byTag(collect(wrap!), 'GridScrollbar'), '滚动条必须挂在 .grid-wrap 下')
  })

  it('.grid-overlay（执行中…/0 行）同样是 .grid 的兄弟', () => {
    assert.ok(!byClass(collect(grid!), 'grid-overlay'), '覆盖层同样不能跟着 scrollLeft 跑')
    assert.ok(byClass(collect(wrap!), 'grid-overlay'))
  })

  it('grid-inner 不再自己撑高度：DOM 里没有与 rowCount 相关的纵向尺寸', () => {
    const inner = byClass(all, 'grid-inner')
    assert.ok(inner)
    const opening = ts.isJsxElement(inner!) ? inner!.openingElement : inner!
    const style = opening.attributes.properties
      .find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'style')
    assert.ok(style)
    const text = style!.getText(sf)
    assert.ok(!/height/i.test(text), `grid-inner 的 style 里不许再出现 height：${text}`)
  })
})

describe('styles.css 里的定位基准与滚动轴', () => {
  it('.grid-wrap 是定位基准，且自己不滚动', () => {
    const b = cssBlock('.grid-wrap')
    assert.match(b, /position:\s*relative/)
    assert.ok(!/overflow/.test(b), '.grid-wrap 一旦变成滚动容器，浮层又会跟着内容跑')
  })

  it('.grid 只滚横轴：纵轴 hidden，因此不存在会被 Chromium 钳位的高度', () => {
    const b = cssBlock('.grid')
    assert.match(b, /overflow-x:\s*auto/)
    assert.match(b, /overflow-y:\s*hidden/)
    assert.match(b, /overflow-anchor:\s*none/)
  })

  it('.grid-vsb / .grid-overlay 都是 absolute（相对 .grid-wrap 定位）', () => {
    assert.match(cssBlock('.grid-vsb'), /position:\s*absolute/)
    assert.match(cssBlock('.grid-overlay'), /position:\s*absolute/)
  })
})
