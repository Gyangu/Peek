/**
 * move_view — relocate one open view (maps onto layout.moveView / layout.splitWithView).
 *
 * The counterpart to set_layout: adjusting a single view should not cost a whole
 * tree. Resending the tree for a one-view change is expensive in tokens and, worse,
 * it invites the model to retype nodes that were fine and get one of them wrong.
 *
 * `zone` is deliberately the same five-way vocabulary the drag-and-drop UI resolves
 * a cursor into, and it goes through the same `dropZonePlacement` table, so an AI
 * makes exactly the gesture a human makes with the mouse — there is no second
 * mapping that could disagree.
 *
 * That equivalence is what changed the meaning of `zone: "center"`. A centre drop
 * used to swap the two views; with tabs it stacks the moved view onto the panel as
 * one more tab and shows it, destroying nothing. Swapping survives as `onOccupied`,
 * reachable by name but by no gesture — an AI can say "these two panes should trade
 * contents", whereas a modifier-drag for it would be undiscoverable.
 */

import { z } from 'zod'
import {
  DROP_ZONES,
  PanelIdSchema,
  ViewIdSchema,
  dropZonePlacement,
  isDropEdgeZone,
  type Command,
} from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { requirePanelExists, requireViewExists } from '../layout-check'
import { renderLayoutOutline, toJson } from '../summary'

/* ================================================================== */
/* 1. Input schema                                                      */
/* ================================================================== */

const InputSchema = z
  .object({
    viewId: ViewIdSchema.describe(
      'The view to move. It must already be open; read_workspace lists every view id, including ' +
        'views that currently sit in no panel.',
    ),
    toPanelId: PanelIdSchema.describe(
      'The panel to drop it on, from read_workspace. It may be the panel the view is already in — ' +
        'that is how a tab is moved to another position in its own tab bar.',
    ),
    zone: z
      .enum(DROP_ZONES)
      .optional()
      .describe(
        'Where on that panel to drop, exactly as a drag would land. ' +
          '"center" (default) adds the view to that panel as a tab and shows it; whatever the panel ' +
          'already held stays open beside it as another tab, so nothing is closed or displaced. ' +
          '"left" / "right" split the panel side by side and put the view alone in the new half; ' +
          '"top" / "bottom" split it above / below. ' +
          'A centre drop onto the panel the view already occupies, at the position it already has, ' +
          'does nothing and is not an error.',
      ),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Position in the destination tab bar, 0 being the leftmost tab. Omitted appends to the right ' +
          'end, which is where the eye expects something new. ' +
          'The number is the position the view ends up at, counted after it has been detached from ' +
          'wherever it was, so the value here is the "tabIndex" read_workspace will report; ' +
          'out-of-range values are clamped rather than rejected. Only valid with zone "center".',
      ),
    activate: z
      .boolean()
      .optional()
      .describe(
        'Show the moved view once it lands (default true). Pass false to slot it in as a background ' +
          'tab, leaving whatever the user was looking at on screen. Only valid with zone "center".',
      ),
    onOccupied: z
      .enum(['stack', 'swap', 'replace'])
      .optional()
      .describe(
        'What happens to the views the destination already holds. ' +
          '"stack" (default) leaves them alone and adds one more tab — this is what a human drag does. ' +
          '"swap" trades places with the destination\'s visible view: it moves to the source panel and ' +
          'takes the tab position this view vacated, so calling again with the ids reversed undoes it ' +
          '(with no source panel it degrades to "stack" rather than losing the view). ' +
          '"replace" closes the destination\'s visible view — destructive, and only ever what you get ' +
          'by asking for it by name. Only valid with zone "center".',
      ),
  })
  .superRefine((value, ctx) => {
    // An edge drop creates a fresh panel that holds this view and nothing else, so
    // there is no tab bar to index into and nothing to displace. Silently ignoring
    // these would let a caller believe it had asked for something it did not get.
    const zone = value.zone ?? 'center'
    if (!isDropEdgeZone(zone)) return
    for (const field of ['index', 'activate', 'onOccupied'] as const) {
      if (value[field] === undefined) continue
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message:
          `"${field}" only applies to zone "center". Zone "${zone}" splits the panel and puts the view ` +
          'alone in the new half, where it is the only tab.',
      })
    }
  })

/* ================================================================== */
/* 2. Result shapes                                                     */
/* ================================================================== */

const MoveResultShape = z.object({
  viewId: z.string(),
  fromPanelId: z.string().nullable(),
  toPanelId: z.string(),
  /** Final position in the destination's tab bar. */
  toIndex: z.number(),
  moved: z.boolean(),
  swappedViewId: z.string().optional(),
  closedViewIds: z.array(z.string()),
  removedPanelIds: z.array(z.string()),
  focusedPanel: z.string().nullable(),
})

const SplitResultShape = z.object({
  viewId: z.string(),
  splitId: z.string(),
  panelId: z.string(),
  fromPanelId: z.string().nullable(),
  moved: z.boolean(),
  removedPanelIds: z.array(z.string()),
  focusedPanel: z.string().nullable(),
})

/* ================================================================== */
/* 3. The tool                                                          */
/* ================================================================== */

export default defineCommandTool({
  kind: 'command',
  name: 'move_view',
  title: 'Move a view',
  description:
    'Move one already-open view into another panel — as a tab on it, or into a new half of it — or ' +
    'to another position in its own tab bar. ' +
    'This is the single-view counterpart to set_layout: use it to nudge one view, and set_layout when ' +
    'the whole arrangement changes. ' +
    'It only relocates — open_view creates a view, close it with the UI or by leaving it out of ' +
    'set_layout, and activate_view switches to a tab without moving anything. ' +
    'It is also the way to bring back a view that has no panel (read_workspace reports those as unplaced).',
  inputSchema: InputSchema,
  // Not destructive by default — a centre drop stacks, and even onOccupied:"swap" is
  // its own undo. Only the explicitly named "replace" closes anything. Not idempotent:
  // repeating a swap puts the two views back where they started.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  toCommands(input, ctx) {
    const snap = ctx.getSnapshot()
    // Diagnostic pre-flight: the handlers reject both of these as well, but only
    // here can the message carry the ids that would have worked.
    requireViewExists(snap, input.viewId, 'move_view')
    requirePanelExists(snap, input.toPanelId, 'move_view')

    const zone = input.zone ?? 'center'
    if (!isDropEdgeZone(zone)) {
      const cmd: Command = {
        name: 'layout.moveView',
        input: {
          viewId: input.viewId,
          toPanelId: input.toPanelId,
          ...(input.index === undefined ? {} : { index: input.index }),
          ...(input.activate === undefined ? {} : { activate: input.activate }),
          // Spelled out rather than left to the Command's default: this is the one
          // place where the tool decides that an unqualified move must not displace
          // anything, and a dispatch record that says so is checkable.
          onOccupied: input.onOccupied ?? 'stack',
        },
      }
      return [cmd]
    }
    const { dir, insert } = dropZonePlacement(zone)
    const cmd: Command = {
      name: 'layout.splitWithView',
      input: { viewId: input.viewId, panelId: input.toPanelId, dir, insert },
    }
    return [cmd]
  },
  render(outcomes, input, ctx) {
    const snap = ctx.getSnapshot()
    const zone = input.zone ?? 'center'
    const outline = `\n\nLayout:\n${renderLayoutOutline(snap)}`

    if (zone === 'center') {
      const parsed = MoveResultShape.safeParse(outcomeData(outcomes, 'layout.moveView'))
      if (!parsed.success) {
        return {
          text: `layout.moveView ran, but its return value could not be parsed.\n\n${toJson(outcomes)}`,
        }
      }
      const r = parsed.data
      const at = `tab ${String(r.toIndex)} of ${r.toPanelId}`
      // Three outcomes worth telling apart, because the caller's next move differs:
      // a reorder inside one panel left the set of panels alone, a real move may have
      // emptied and removed the source, and a no-op means the view is already exactly
      // where it was asked to be — not that anything failed.
      const head = !r.moved
        ? `${r.viewId} was already ${at}${input.activate === false ? '' : ' and already showing'}; nothing changed.`
        : r.fromPanelId === r.toPanelId
          ? `Reordered ${r.viewId} within ${r.toPanelId}; it is now ${at}.`
          : `Moved ${r.viewId} from ${r.fromPanelId ?? '(no panel)'} into ${r.toPanelId} as ${at}.`
      // Only ever an explicit onOccupied:"swap" with a source panel to trade with —
      // the default stacks and displaces nothing, and a swap with nowhere to send the
      // displaced view degrades to stacking rather than unmounting it.
      const swap =
        r.swappedViewId === undefined
          ? ''
          : ` ${r.swappedViewId} took its place in ${r.fromPanelId ?? '(no panel)'}.`
      const closed = r.closedViewIds.length === 0 ? '' : ` Closed: ${r.closedViewIds.join(', ')}.`
      const removed =
        r.removedPanelIds.length === 0
          ? ''
          : ` Panel ids that no longer exist: ${r.removedPanelIds.join(', ')}.`
      return {
        text: `${head}${swap}${closed}${removed} Focused panel: ${r.focusedPanel ?? '(none)'}.${outline}`,
        data: r,
      }
    }

    const parsed = SplitResultShape.safeParse(outcomeData(outcomes, 'layout.splitWithView'))
    if (!parsed.success) {
      return {
        text: `layout.splitWithView ran, but its return value could not be parsed.\n\n${toJson(outcomes)}`,
      }
    }
    const r = parsed.data
    const head = r.moved
      ? `Split ${input.toPanelId} (${zone}) and moved ${r.viewId} into the new panel ${r.panelId}, inside split ${r.splitId}.`
      : `${r.viewId} was the only view in ${input.toPanelId}; splitting it off would have undone itself, so nothing changed.`
    const removed =
      r.removedPanelIds.length === 0
        ? ''
        : ` Panel ids that no longer exist: ${r.removedPanelIds.join(', ')}.`
    return {
      text: `${head}${removed} Focused panel: ${r.focusedPanel ?? '(none)'}.${outline}`,
      data: r,
    }
  },
})
