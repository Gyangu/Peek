/**
 * activate_view — bring a view that is already mounted to the front of its panel
 * (maps onto view.activate).
 *
 * ## Why this is a tool of its own
 *
 * Tabs introduced a state nothing else could express: a view that is open, mounted,
 * holding a result set, and simply *behind* another one. Every existing tool that
 * could reach it would change something else on the way — `move_view` relocates (an
 * unqualified centre drop onto its own panel appends it to the right end of the tab
 * bar, silently reordering the user's tabs), `open_view` creates a second view of
 * the same table, and `set_layout` rewrites the whole window to change which tab is
 * showing. None of those is "show me that one".
 *
 * Without it an AI can put a view on screen only by disturbing something. With it,
 * the read side of the contract closes too: `read_workspace` reports `visible` per
 * view, so a model that notices it has been describing a hidden tab has exactly one
 * cheap, non-destructive way to fix it.
 */

import { z } from 'zod'
import { commandSchemas, ViewIdSchema } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { requireViewMounted } from '../layout-check'
import { renderPanelBrief, toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = commandSchemas['view.activate'].safeExtend({
  viewId: ViewIdSchema.describe(
    'The view to bring to the front. It must already be mounted on a panel; read_workspace reports ' +
      'every view with "visible": false for the ones sitting behind another tab, and lists views ' +
      'that are on no panel at all under "unplacedViews" (move_view places those).',
  ),
  focusPanel: z
    .boolean()
    .optional()
    .describe(
      "Also make that view's panel the focused one (default true), which is where the user's " +
        'keyboard goes and where open_view lands by default. Pass false to bring a tab forward in a ' +
        'panel the user is not working in without moving their focus there.',
    ),
})

/* ================================================================== */
/* 2. Result shape                                                      */
/* ================================================================== */

const ActivateResultShape = z.object({
  viewId: z.string(),
  panelId: z.string(),
  previousViewId: z.string().nullable(),
  focusedPanel: z.string().nullable(),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'activate_view',
  title: 'Show a tab',
  description:
    'Switch a panel to one of the views stacked in it, the way clicking its tab does. ' +
    'A panel holds several views as tabs and shows one of them; this changes which one, and changes ' +
    'nothing else — no view is opened, closed, moved or reordered. ' +
    'Use it when read_workspace shows the view you care about with "visible": false. ' +
    'For a view that sits in no panel at all use move_view instead; to change the tab order use ' +
    'move_view with an index; to rearrange the panes themselves use set_layout.',
  inputSchema: InputSchema,
  // Nothing is created or destroyed, and activating the same view twice leaves the
  // same workspace, so this is the rare layout tool that is genuinely idempotent.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  toCommands(input, ctx) {
    // Diagnostic pre-flight: the handler refuses an unmounted view as well, but only
    // here can the refusal name move_view as the repair and list what is addressable.
    requireViewMounted(ctx.getSnapshot(), input.viewId, 'activate_view')
    return [{ name: 'view.activate', input }]
  },
  render(outcomes, _input, ctx) {
    const parsed = ActivateResultShape.safeParse(outcomeData(outcomes, 'view.activate'))
    if (!parsed.success) {
      return { text: `view.activate ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const r = parsed.data
    const snap = ctx.getSnapshot()
    // A no-op is reported as one rather than dressed up as a change: the caller asked
    // for a state, and it already held.
    const head =
      r.previousViewId === r.viewId
        ? `${r.viewId} was already the visible tab of ${r.panelId}; nothing changed.`
        : `${r.panelId} now shows ${r.viewId}` +
          `${r.previousViewId === null ? '' : `, instead of ${r.previousViewId}`}. ` +
          `${r.previousViewId === null ? '' : `${r.previousViewId} is still open as a background tab.`}`
    return {
      text: `${head}\nFocused panel: ${r.focusedPanel ?? '(none)'}.\n\nCurrent panels:\n${renderPanelBrief(snap)}`,
      data: r,
    }
  },
})
