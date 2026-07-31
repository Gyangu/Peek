/**
 * read_workspace — read-only tool that lets the AI "see" the current UI.
 *
 * Reads the snapshot of main's Workspace source of truth directly (zero renderer round-trips,
 * PLAN section 3). Returns the layout tree plus a summary of every view: where each panel sits,
 * its view kind, the database it is connected to, the table or query it shows, its row count and
 * whether it is still loading. **No result set data is ever included** — that lives in the UI.
 */

import { z } from 'zod'
import { defineReadTool } from '../executor'
import { buildWorkspaceBrief, renderLayoutOutline, toJson, type BriefSection } from '../summary'

const SectionSchema = z.enum(['layout', 'views', 'connections', 'results'])

const InputSchema = z.object({
  /** Fetch only the sections you need, to save tokens; omit for everything. */
  include: z.array(SectionSchema).min(1).optional(),
  /** Attach the raw layout tree (with each split's id/dir/ratio, which layout.setRatio needs). */
  withLayoutTree: z.boolean().optional(),
})

export default defineReadTool({
  kind: 'read',
  name: 'read_workspace',
  title: 'Read UI state',
  description:
    "Read peek's current UI state: the tiled layout tree, which view sits in each panel, which " +
    'database it is connected to, which table or query it is showing, each result set\'s row count ' +
    'and loading status, and the capability set of every connection. ' +
    'Read this before any operation that changes the UI. The response contains no result set data. ' +
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
    if (want('layout') || want('views')) payload['panels'] = brief.panels
    if (want('connections')) payload['connections'] = brief.connections
    if (want('results')) payload['results'] = brief.results
    if (input.withLayoutTree === true) payload['layout'] = brief.layout

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
