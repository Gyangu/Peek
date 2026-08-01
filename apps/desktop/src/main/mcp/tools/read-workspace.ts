/**
 * read_workspace — read-only tool that lets the AI "see" the current UI.
 *
 * Reads the snapshot of main's Workspace source of truth directly (zero renderer round-trips,
 * PLAN section 3). Returns the layout tree plus a summary of every view: where each panel sits,
 * its view kind, the database it is connected to, the table or query it shows, its row count and
 * whether it is still loading. **No result set data is ever included** — that lives in the UI.
 *
 * This is also the input side of set_layout / move_view: the panel ids, view ids and the
 * structured `layout` tree returned here are precisely what those tools take, so an AI can read
 * a tree, edit it, strip the ids the system owns, and send it back.
 */

import { z } from 'zod'
import { defineReadTool } from '../executor'
import { buildWorkspaceBrief, renderLayoutOutline, toJson, type BriefSection } from '../summary'

const SectionSchema = z.enum(['layout', 'views', 'connections', 'results'])

const InputSchema = z.object({
  /** Fetch only the sections you need, to save tokens; omit for everything. */
  include: z.array(SectionSchema).min(1).optional(),
  /**
   * Deprecated and ignored: the structured layout tree now always accompanies the `layout`
   * section. Kept so existing callers do not fail validation.
   */
  withLayoutTree: z.boolean().optional(),
})

export default defineReadTool({
  kind: 'read',
  name: 'read_workspace',
  title: 'Read UI state',
  description:
    "Read peek's current UI state: the tiled layout tree, the views stacked as tabs in each panel " +
    'and which one of them is on screen, which database each is connected to, which table or query ' +
    "it is showing, each result set's row count and loading status, and the capability set of every " +
    'connection. ' +
    'Read this before any operation that changes the UI. The response contains no result set data. ' +
    'The panel ids, view ids and the structured "layout" tree it returns are what set_layout and ' +
    'move_view take as input, and "rev" is what set_layout\'s expectRev compares against. ' +
    'A panel holds a list of tabs: each entry of "panels" carries "views" in tab-bar order plus the ' +
    '"activeViewId" the user can actually see, and every view carries "visible". Being in a panel is ' +
    'no longer the same as being on screen — a view with visible:false is open and addressable but ' +
    'hidden behind another tab, and activate_view brings it forward. ' +
    '"unplacedViews" lists views that are open but sit in no panel at all: still connected, still ' +
    'holding their rows, invisible to the user until move_view or set_layout puts them back on screen. ' +
    'A result status of paused means "backpressure stopped the stream", not "the query failed": ' +
    'such a result has rowsUsable=true, the rows already loaded can be used as they are, and ' +
    'running the query again resumes fetching. Only error is a real failure (rowsUsable=false).',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  read(input, ctx) {
    const snap = ctx.getSnapshot()
    const include: readonly BriefSection[] | undefined = input.include
    const brief = buildWorkspaceBrief(snap, include)

    const payload: Record<string, unknown> = {
      rev: brief.rev,
      focusedPanel: brief.focusedPanel,
    }
    const want = (s: BriefSection): boolean => include === undefined || include.includes(s)
    if (want('layout') || want('views')) {
      payload['panels'] = brief.panels
      payload['unplacedViews'] = brief.unplacedViews
    }
    if (want('connections')) payload['connections'] = brief.connections
    if (want('results')) payload['results'] = brief.results
    // Unconditional with the layout section, rather than behind a flag: the tree has a
    // single-digit number of nodes, and proposing a new one without seeing the old one is
    // guesswork. One fewer round-trip is one fewer chance to guess wrong.
    if (want('layout')) payload['layout'] = brief.layout

    const outline = want('layout') ? `Layout:\n${renderLayoutOutline(snap)}\n\n` : ''
    const connLine =
      brief.connections.length > 0
        ? `Connections: ${brief.connections.map((c) => `${c.label}(${c.connId}, ${c.driverId}, ${c.status})`).join('; ')}\n\n`
        : 'Connections: none\n\n'

    return {
      text: `workspace rev=${brief.rev}\n\n${outline}${want('connections') ? connLine : ''}${toJson(payload)}`,
      data: payload,
    }
  },
})
