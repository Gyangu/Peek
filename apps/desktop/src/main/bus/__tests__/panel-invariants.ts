import assert from 'node:assert/strict'
import { MAX_PANEL_TABS, type LayoutNode } from '@peek/core'

/**
 * The shared panel-invariant checker, P1 through P5 over a whole layout tree.
 *
 * ## Why this is not in a `.test.ts` file
 *
 * It used to live at the bottom of `panel-node.test.ts` and be imported from
 * `layout-ops.test.ts`. `node:test` starts one process per test *file*, but an
 * `import` of a `.test.ts` module executes its top-level `test(...)` calls in
 * the importing process too — so every case in `panel-node.test.ts` was
 * registered and run a second time inside the `layout-ops` run, inflating the
 * reported total by exactly that file's size while adding no coverage.
 *
 * The module therefore has no `test(...)` of its own and a name that does not
 * match the `*.test.ts` glob in `package.json`, so the runner never collects it.
 * `panel-node.test.ts` keeps the cases that prove this checker rejects each way
 * of breaking the invariants; both test files import the checker from here.
 *
 * ## What it does not cover
 *
 * The split/ratio half of "is this tree sound" — `layout-ops.test.ts` owns that
 * as `assertStructurallySound`. The two are meant to be called together on the
 * output of every operation that rewrites the tree.
 */
export function assertPanelInvariants(node: LayoutNode, label: string): void {
  const seen = new Set<string>()
  const walk = (n: LayoutNode): void => {
    if (n.type === 'split') {
      n.children.forEach(walk)
      return
    }
    // P1, in both directions.
    assert.equal(
      n.activeViewId === null,
      n.viewIds.length === 0,
      `${label}: ${n.id} breaks P1 (activeViewId null iff viewIds empty)`,
    )
    // P2
    if (n.activeViewId !== null) {
      assert.ok(n.viewIds.includes(n.activeViewId), `${label}: ${n.id} breaks P2 (active tab is not a tab)`)
    }
    // P3 within the panel, P4 across the tree — one set catches both.
    for (const viewId of n.viewIds) {
      assert.equal(seen.has(viewId), false, `${label}: ${viewId} is mounted twice (P3/P4)`)
      seen.add(viewId)
    }
    // P5
    assert.ok(
      n.viewIds.length <= MAX_PANEL_TABS,
      `${label}: ${n.id} holds ${String(n.viewIds.length)} tabs, over the cap (P5)`,
    )
  }
  walk(node)
}
