/**
 * set_ratio — change how much space a split gives each of its children
 * (maps onto layout.setRatio).
 *
 * ## Why this is a tool of its own
 *
 * `read_workspace` has always reported every split with its id, its direction and
 * its current ratio. Until this file existed there was nothing to do with that: the
 * only way to widen a pane was `set_layout` with the entire tree rebuilt around one
 * changed number — the most expensive call in the tool surface, spent on the one
 * kind of change that alters no view, no tab and no panel identity. Worse, it made a
 * caller restate every panel it did *not* want to touch, and a tree restated from
 * memory is where views get left out.
 *
 * So this is the resize gesture, and nothing else: the same drag on a split bar the
 * user makes with a mouse. `set_layout` keeps the whole-window rewrite.
 *
 * Genuinely idempotent, non-destructive, and the one layout tool that cannot lose
 * anything — which is also why it takes no `expectRev`: a stale `splitId` is caught
 * by the pre-flight, and a stale *ratio* is not a hazard worth a round trip.
 */

import { z } from 'zod'
import { commandSchemas, SplitIdSchema } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { requireSplitRatio } from '../layout-check'
import { renderLayoutOutline, toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = commandSchemas['layout.setRatio'].safeExtend({
  splitId: SplitIdSchema.describe(
    'The split to resize. read_workspace reports one for every division in the window, in its ' +
      '"layout" tree, each with its "dir" and current "ratio". Split ids are minted fresh whenever ' +
      'the tree changes shape, so read them again after a set_layout rather than reusing old ones.',
  ),
  ratio: z
    .array(z.number().positive())
    .min(2)
    .describe(
      'One positive number per child of that split, in the order the split divides the space — ' +
        'left to right for dir "row", top to bottom for dir "col". They are normalized to sum to 1, ' +
        'so [0.65,0.35], [65,35] and [2,1.077] are all the same request. The length must match the ' +
        "split's child count exactly; the error says what that count is.",
    ),
})

/* ================================================================== */
/* 2. Result shape                                                      */
/* ================================================================== */

const SetRatioResultShape = z.object({
  splitId: z.string(),
  ratio: z.array(z.number()),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'set_ratio',
  title: 'Resize a split',
  description:
    'Change how a split divides its space between its children — the same gesture as dragging a ' +
    'divider between two panes. Nothing is opened, closed, moved or re-stacked. ' +
    'Use it whenever the arrangement is already right and only the proportions are wrong ("make the ' +
    'results pane wider"); use set_layout only when panes themselves have to change. ' +
    'Take the splitId and the number of children from read_workspace, which reports the layout tree ' +
    'with every split id, direction and current ratio.',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  toCommands(input, ctx) {
    // Diagnostic pre-flight: the handler refuses both of these too, but its replies
    // cannot describe the tree the caller was aiming at — which splits exist, and how
    // many children the one they named actually has.
    requireSplitRatio(ctx.getSnapshot(), input.splitId, input.ratio)
    return [{ name: 'layout.setRatio', input }]
  },
  render(outcomes, _input, ctx) {
    const parsed = SetRatioResultShape.safeParse(outcomeData(outcomes, 'layout.setRatio'))
    if (!parsed.success) {
      return { text: `layout.setRatio ran, but its return value could not be parsed.\n\n${toJson(outcomes)}` }
    }
    const r = parsed.data
    const snap = ctx.getSnapshot()
    // The normalized shares, not the ones that were sent: [65,35] came back as
    // 0.65/0.35, and the caller should read the number the window is actually using.
    const shares = r.ratio.map((v) => v.toFixed(2)).join(' / ')
    return {
      text:
        `${r.splitId} now divides its space ${shares} · workspace rev=${String(snap.rev)}\n\n` +
        `Layout:\n${renderLayoutOutline(snap)}`,
      data: r,
    }
  },
})
