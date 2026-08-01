/**
 * set_layout — arrange the whole window in one declarative step (maps onto layout.setLayout).
 *
 * This is the tool that makes "put these four tables side by side so I can compare
 * them" a single call. The imperative alternative (split, split, move, move, focus)
 * costs one round-trip per step, and every round-trip is a chance for the model to
 * act on a panel id that the previous step invalidated. Sending the target tree
 * instead is atomic: either the whole tree applies, or nothing changes.
 *
 * The tool itself stays a thin shell — validate, pre-flight the ids so a failure
 * can name the ones that would have worked, dispatch one Command. Every rule about
 * what a tree may look like lives in `LayoutSetLayoutInputSchema`, and every rule
 * about what happens to the workspace lives in the `layout.setLayout` handler.
 */

import { z } from 'zod'
import {
  LayoutSetLayoutInputSchema,
  LayoutSetLayoutObjectSchema,
  LayoutSpecPanelSchema,
  LayoutSpecSplitSchema,
  MAX_LAYOUT_DEPTH,
  MAX_LAYOUT_PANELS,
  MAX_PANEL_TABS,
  MAX_SPLIT_CHILDREN,
  UnplacedPolicySchema,
  ViewIdSchema,
  type LayoutSpecNode,
} from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import {
  collectSpecPanels,
  requireConnExists,
  requirePanelExists,
  requireRev,
  requireViewExists,
} from '../layout-check'
import { renderLayoutOutline, toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

/**
 * Field descriptions matter more here than anywhere else in the tool surface:
 * they are the only thing the model reads before writing a nested tree, and a
 * tree is the one input it cannot arrive at by trial and error cheaply. The
 * shapes themselves come straight from core, so what is added below is prose,
 * never a second definition.
 */
const TREE_DOC = [
  'The window you want, as a tree of two node kinds.',
  '',
  'panel leaf — one tiled pane holding a stack of tabs, of which exactly one is visible:',
  '  {"type":"panel","viewIds":["view_2"]}',
  '        one tab. Ids come from read_workspace; the view must already exist.',
  '  {"type":"panel","viewIds":["view_2","view_5","view_7"],"activeViewId":"view_5"}',
  '        three tabs in one pane, left to right in the order written, showing the middle one.',
  '  {"type":"panel","open":[{"kind":"query","connId":"conn_1","text":"select 1"}]}',
  '        open brand-new views right here; each entry takes the same spec as open_view',
  '        (table / query / inspector / tree / vector) and becomes a tab after the "viewIds" ones.',
  '  {"type":"panel"}',
  '        an empty pane. Legal and ordinary — it is what a fresh window holds.',
  '',
  'panel leaf rules:',
  '  "viewIds" order IS the tab-bar order and is applied exactly as written, never sorted.',
  '  "activeViewId" must be one of this leaf\'s own "viewIds". A view created by "open" cannot be',
  '        named there — it has no id until this call runs. Omit the field to show the first tab.',
  '  "viewIds" and "open" combine freely in one leaf; a leaf holds at most ' +
    String(MAX_PANEL_TABS) +
    ' tabs, the two counted together.',
  '  There is no singular "viewId" field. One view is "viewIds":["view_2"].',
  '  A view may appear in at most one leaf, once — listing it twice is rejected, not deduplicated.',
  '  optional "panelId": pin this leaf to an existing panel so it keeps that id',
  '  optional "key": your own label for this leaf, echoed back next to the panel id it received',
  '',
  'split node — divides its area among 2..' +
    String(MAX_SPLIT_CHILDREN) +
    ' children:',
  '  {"type":"split","dir":"row","children":[<node>,<node>],"ratio":[0.6,0.4]}',
  '  dir "row" places children left to right, dir "col" places them top to bottom.',
  '  "ratio" is one positive number per child and is normalized to sum to 1; omit it for equal shares.',
  '',
  'Tabs or panes? Panes are for views the user compares side by side; tabs are for views that',
  'share one place on screen and are switched between. Four tables to compare is four leaves;',
  'four tables to page through is one leaf with four "viewIds".',
  '',
  'Example — a 2x2 grid of four open views, left column narrower:',
  '{"tree":{"type":"split","dir":"row","ratio":[0.4,0.6],"children":[',
  '  {"type":"split","dir":"col","children":[{"type":"panel","viewIds":["view_1"]},{"type":"panel","viewIds":["view_2"]}]},',
  '  {"type":"split","dir":"col","children":[{"type":"panel","viewIds":["view_3"]},{"type":"panel","viewIds":["view_4"]}]}]}}',
  '',
  'Example — three tables stacked as tabs on the left showing the second, a query pane on the right:',
  '{"tree":{"type":"split","dir":"row","ratio":[0.6,0.4],"children":[',
  '  {"type":"panel","viewIds":["view_1","view_2","view_3"],"activeViewId":"view_2","key":"tables"},',
  '  {"type":"panel","open":[{"kind":"query","connId":"conn_1","text":"select 1"}]}]},',
  ' "focusKey":"tables"}',
].join('\n')

/**
 * The tree schema, rebuilt over core's leaf shapes for one reason: **strictness**.
 *
 * A plain zod object silently drops keys it does not know, so a leaf written
 * `{"type":"panel","viewId":"view_1"}` — the field this schema replaced, and the
 * spelling any model that saw an older peek will reach for — parses cleanly into an
 * *empty* panel. Combined with the default `unplaced:"close"` that quietly closes
 * view_1. A dropped key must not be able to destroy a view, so unknown keys are a
 * hard error and the failure names the leaf that carried one.
 *
 * The field shapes still come from core (`LayoutSpecPanelSchema`,
 * `LayoutSpecSplitSchema`); only the recursion is restated, because `.strict()`
 * cannot reach through a `z.lazy` defined elsewhere.
 */
const StrictSpecNodeSchema: z.ZodType<LayoutSpecNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    LayoutSpecPanelSchema.strict(),
    LayoutSpecSplitSchema.safeExtend({
      children: z.array(StrictSpecNodeSchema).min(2).max(MAX_SPLIT_CHILDREN),
    }).strict(),
  ]),
)

const InputObjectSchema = LayoutSetLayoutObjectSchema.safeExtend({
  tree: StrictSpecNodeSchema.describe(TREE_DOC),
  unplaced: UnplacedPolicySchema.optional().describe(
    'What to do with views that are open but absent from the tree. ' +
      '"close" (default) closes them, so the tree really is the whole window. ' +
      '"keep" unmounts them: they stay open with no panel, invisible to the user until a later ' +
      'set_layout or move_view puts them back. ' +
      '"error" refuses the whole call instead, which is how you find out you forgot one.',
  ),
  focusViewId: ViewIdSchema.optional().describe(
    'Focus the panel that ends up holding this view. Mutually exclusive with focusKey. ' +
      'With neither, the currently focused panel keeps focus if it survives the rewrite.',
  ),
  focusKey: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Focus the panel produced by the leaf carrying this key — the only way to focus an empty panel. ' +
        'Mutually exclusive with focusViewId.',
    ),
  expectRev: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Apply only while the workspace is still at this revision (read_workspace returns it as "rev"). ' +
        'Use it when you read the workspace, thought about it, and are now sending a tree built from ' +
        'what you saw: without it a change the user made in between is silently overwritten.',
    ),
})

/**
 * Whole-tree rules (duplicate ids, depth, panel count, focus targets) are
 * delegated to core's own refinement rather than restated, so the tool cannot
 * drift from the Command. Every issue keeps the path of the offending node, and
 * the executor renders those paths into the error, which is what lets the model
 * repair one leaf instead of resending the tree blind.
 */
const InputSchema = InputObjectSchema.superRefine((value, ctx) => {
  const checked = LayoutSetLayoutInputSchema.safeParse(value)
  if (checked.success) return
  for (const issue of checked.error.issues) {
    ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
  }
})

/* ================================================================== */
/* 2. Result shape (parsed rather than cast — no `any` on this path)    */
/* ================================================================== */

const SetLayoutResultShape = z.object({
  panels: z.array(
    z.object({
      key: z.string().optional(),
      panelId: z.string(),
      /** Final tab-bar contents, mounted views first then the newly opened ones. */
      viewIds: z.array(z.string()),
      activeViewId: z.string().nullable(),
    }),
  ),
  createdPanelIds: z.array(z.string()),
  openedViewIds: z.array(z.string()),
  unplacedViewIds: z.array(z.string()),
  closedViewIds: z.array(z.string()),
  removedPanelIds: z.array(z.string()),
  focusedPanel: z.string().nullable(),
})

function idLine(label: string, ids: readonly string[]): string {
  return ids.length === 0 ? '' : `${label}: ${ids.join(', ')}\n`
}

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'set_layout',
  title: 'Arrange the window',
  description:
    'Rearrange every panel in the peek window at once by describing the tiled layout you want. ' +
    'Use this to put several views side by side for comparison, or to stack several as tabs in one ' +
    'pane; use move_view instead when a single view needs to change places. Read read_workspace ' +
    'first: the view ids and panel ids it returns are what this tool takes. ' +
    'Each panel leaf lists its tabs in "viewIds" (views that already exist) and may name which of ' +
    'them is visible in "activeViewId"; a leaf can also carry "open" specs to create new views in ' +
    'place (same arguments as open_view). ' +
    `Limits: at most ${String(MAX_LAYOUT_PANELS)} panels, at most ${String(MAX_PANEL_TABS)} tabs per panel, ` +
    `nesting at most ${String(MAX_LAYOUT_DEPTH)} levels deep, ` +
    `2 to ${String(MAX_SPLIT_CHILDREN)} children per split, and one view may appear in at most one panel, once. ` +
    'Views left out of the tree are closed by default — pass unplaced:"keep" to park them instead, or ' +
    'unplaced:"error" to be told about them rather than lose them. ' +
    'The call is atomic: if any part is rejected the window does not change at all, and the error names ' +
    'the node that broke the rule.',
  inputSchema: InputSchema,
  // destructive: the default unplaced policy closes views the tree left out.
  // Not idempotent: a leaf carrying `open` creates a fresh view on every call, so a
  // client that retries "safely" would end up with duplicates.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  toCommands(input, ctx) {
    const snap = ctx.getSnapshot()
    requireRev(snap, input.expectRev)

    // Diagnostic pre-flight only: the handler rejects all of these too, but it
    // cannot list the ids that would have worked, and that list is the difference
    // between a model that corrects itself and one that guesses again.
    collectSpecPanels(input.tree).forEach((leaf, index) => {
      const where = `tree leaf #${String(index + 1)}${leaf.key === undefined ? '' : ` (key "${leaf.key}")`}`
      for (const [tab, viewId] of (leaf.viewIds ?? []).entries()) {
        requireViewExists(snap, viewId, `${where} tab #${String(tab + 1)}`)
      }
      if (leaf.panelId !== undefined) requirePanelExists(snap, leaf.panelId, where, 'BAD_REQUEST')
      for (const [i, spec] of (leaf.open ?? []).entries()) {
        // A chat spec's `connId` is optional and advisory — a conversation is not
        // a window onto a connection — so there is nothing to pre-flight when it
        // is absent.
        if (spec.connId === undefined) continue
        requireConnExists(snap, spec.connId, `${where} open #${String(i + 1)}`)
      }
    })

    return [{ name: 'layout.setLayout', input }]
  },
  render(outcomes, _input, ctx) {
    const parsed = SetLayoutResultShape.safeParse(outcomeData(outcomes, 'layout.setLayout'))
    const snap = ctx.getSnapshot()
    if (!parsed.success) {
      return {
        text: `layout.setLayout ran, but its return value could not be parsed.\n\n${toJson(outcomes)}`,
      }
    }
    const result = parsed.data

    const panelLines = result.panels
      .map((p, i) => {
        const key = p.key === undefined ? '' : ` [${p.key}]`
        // Every tab id, with the visible one marked: a leaf that carried three
        // viewIds has to be checkable against three ids, and "which one is on
        // screen" is the half of the answer the tree spec could not state.
        const tabs =
          p.viewIds.length === 0
            ? '(empty)'
            : p.viewIds.map((v) => `${v}${v === p.activeViewId ? ' (active)' : ''}`).join(', ')
        const created = result.createdPanelIds.includes(p.panelId) ? ' (new panel)' : ''
        return `  ${String(i + 1)}.${key} ${p.panelId} → ${tabs}${created}`
      })
      .join('\n')

    return {
      text:
        `Layout applied · ${String(result.panels.length)} panel(s) · workspace rev=${String(snap.rev)}\n\n` +
        `Panels in visual order:\n${panelLines}\n` +
        idLine('Views opened by this call', result.openedViewIds) +
        idLine('Views closed (absent from the tree)', result.closedViewIds) +
        idLine('Views parked with no panel', result.unplacedViewIds) +
        idLine('Panel ids that no longer exist', result.removedPanelIds) +
        `Focused panel: ${result.focusedPanel ?? '(none)'}\n\n` +
        `Layout:\n${renderLayoutOutline(snap)}`,
      data: result,
    }
  },
})
