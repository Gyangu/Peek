/**
 * Tests for the layout MCP tools: set_layout, move_view, activate_view, and
 * read_workspace's layout reporting.
 *
 * These exercise the tool shell only — a fake dispatch records what the tool
 * decided to send. That is exactly the boundary the tools own: which Command,
 * with which arguments, and whether a malformed request is rejected before it can
 * reach the bus at all. What a Command then does to the tree is the handler's
 * business and is covered by bus/__tests__/layout-ops.test.ts.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import {
  MAX_PANEL_TABS,
  asConnId,
  asPanelId,
  asSplitId,
  asViewId,
  collectPanels,
  commandOk,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type CommandResultFor,
  type LayoutNode,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'
import readWorkspace from '../tools/read-workspace'
import activateView from '../tools/activate-view'
import moveView from '../tools/move-view'
import setLayout from '../tools/set-layout'
import type { CommandDispatch, ToolContext, ToolOutput } from '../types'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Dispatched {
  name: CommandName
  input: unknown
}

/**
 * panel_a stacks two tabs and shows the first; view_4 is therefore mounted and
 * invisible, which is the state that did not exist before tabs and that every
 * reader here has to keep straight. panel_b holds one. view_3 sits nowhere.
 */
const LAYOUT: LayoutNode = {
  type: 'split',
  id: asSplitId('split_1'),
  dir: 'row',
  ratio: [0.5, 0.5],
  children: [
    {
      type: 'panel',
      id: asPanelId('panel_a'),
      viewIds: [asViewId('view_1'), asViewId('view_4')],
      activeViewId: asViewId('view_1'),
    },
    { type: 'panel', id: asPanelId('panel_b'), viewIds: [asViewId('view_2')], activeViewId: asViewId('view_2') },
  ],
}

/**
 * View summaries are derived from the layout rather than written out beside it,
 * so `panelId` / `tabIndex` / `visible` cannot drift away from the tree they
 * describe — a fixture that claimed a view was visible while the tree had it
 * behind another tab would make the assertions below meaningless.
 */
function viewSummaries(layout: LayoutNode, unplaced: readonly string[]): ViewSummary[] {
  const out: ViewSummary[] = []
  const base = (id: string): Omit<ViewSummary, 'panelId' | 'tabIndex' | 'visible'> => ({
    id: asViewId(id),
    kind: 'table',
    connId: asConnId('conn_1'),
    title: id,
    status: 'ready',
    describe: `Table public.${id}`,
  })
  for (const panel of collectPanels(layout)) {
    panel.viewIds.forEach((viewId, tabIndex) => {
      out.push({
        ...base(String(viewId)),
        panelId: panel.id,
        tabIndex,
        visible: panel.activeViewId === viewId,
      })
    })
  }
  for (const id of unplaced) out.push({ ...base(id), panelId: null, tabIndex: -1, visible: false })
  return out
}

function snapshot(): WorkspaceSnapshot {
  return {
    rev: 7,
    layout: LAYOUT,
    focusedPanel: asPanelId('panel_a'),
    connections: [
      {
        id: asConnId('conn_1'),
        driverId: 'postgres',
        label: 'local',
        endpoint: 'localhost:5432/demo',
        status: 'ready',
        capabilities: ['tabularQuery'],
        config: { driverId: 'postgres', url: 'postgresql://app@localhost:5432/demo' },
      },
    ],
    views: viewSummaries(LAYOUT, ['view_3']),
    results: [],
  }
}

interface Harness {
  ctx: ToolContext
  sent: Dispatched[]
}

/**
 * `CommandDispatch` promises a result type the *caller* picks, so a fake that
 * returns canned data has to widen once. The assertion is confined to this one
 * line; nothing in a test body needs one.
 */
function fakeDispatch(sent: Dispatched[], reply: (cmd: Dispatched) => unknown): CommandDispatch {
  return async <K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandResultFor<K>> => {
    const cmd: Dispatched = { name, input }
    sent.push(cmd)
    const result: CommandResult<unknown> = commandOk('cmd_1', 8, reply(cmd))
    return result as CommandResultFor<K>
  }
}

function harness(reply: (cmd: Dispatched) => unknown = () => ({})): Harness {
  const sent: Dispatched[] = []
  const ctx: ToolContext = {
    dispatch: fakeDispatch(sent, reply),
    getSnapshot: snapshot,
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }
  return { ctx, sent }
}

function panelLeaf(viewIds?: string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'panel', ...(viewIds === undefined ? {} : { viewIds }), ...extra }
}

const SET_LAYOUT_RESULT = {
  panels: [
    { key: 'left', panelId: 'panel_a', viewIds: ['view_1', 'view_4'], activeViewId: 'view_4' },
    { panelId: 'panel_b', viewIds: [], activeViewId: null },
  ],
  createdPanelIds: [],
  openedViewIds: [],
  unplacedViewIds: [],
  closedViewIds: ['view_2'],
  removedPanelIds: [],
  focusedPanel: 'panel_a',
}

async function run(tool: { run(raw: unknown, ctx: ToolContext): Promise<ToolOutput> }, input: unknown, h: Harness): Promise<ToolOutput> {
  return tool.run(input, h.ctx)
}

/* ------------------------------------------------------------------ */
/* set_layout — mapping                                                */
/* ------------------------------------------------------------------ */

test('set_layout sends exactly one layout.setLayout command, unaltered', async () => {
  const h = harness(() => SET_LAYOUT_RESULT)
  const tree = {
    type: 'split',
    dir: 'row',
    ratio: [0.4, 0.6],
    children: [panelLeaf(['view_1', 'view_4'], { key: 'left', activeViewId: 'view_4' }), panelLeaf(['view_3'])],
  }
  const out = await run(setLayout, { tree, unplaced: 'close', focusViewId: 'view_1' }, h)

  assert.equal(out.isError, undefined)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.name, 'layout.setLayout')
  assert.deepEqual(h.sent[0]?.input, { tree, unplaced: 'close', focusViewId: 'view_1' })
})

test('set_layout passes a multi-tab leaf through with its tab order intact', async () => {
  const h = harness(() => SET_LAYOUT_RESULT)
  // P6: the order of viewIds is the tab-bar order and is state, so a tool that
  // normalised or sorted it would destroy the only thing this leaf was saying.
  const tree = panelLeaf(['view_4', 'view_1', 'view_2'], { activeViewId: 'view_1' })
  await run(setLayout, { tree }, h)
  assert.deepEqual(h.sent[0]?.input, { tree })
})

test('set_layout accepts a leaf that mounts existing views and opens new ones together', async () => {
  const h = harness(() => SET_LAYOUT_RESULT)
  const tree = panelLeaf(['view_1'], { open: [{ kind: 'query', connId: 'conn_1', text: 'select 1' }] })
  const out = await run(setLayout, { tree }, h)
  assert.equal(out.isError, undefined, 'viewIds and open stopped being mutually exclusive')
  assert.equal(h.sent.length, 1)
})

test('set_layout receipt names each panel, its key, every tab and the visible one', async () => {
  const h = harness(() => SET_LAYOUT_RESULT)
  const out = await run(
    setLayout,
    {
      tree: {
        type: 'split',
        dir: 'row',
        children: [panelLeaf(['view_1', 'view_4'], { key: 'left', activeViewId: 'view_4' }), panelLeaf()],
      },
    },
    h,
  )
  assert.match(out.text, /\[left\] panel_a → view_1, view_4 \(active\)/)
  assert.match(out.text, /panel_b → \(empty\)/)
  assert.match(out.text, /Views closed \(absent from the tree\): view_2/)
  assert.match(out.text, /Focused panel: panel_a/)
  // The tree the caller now has to reason about comes back with the receipt.
  assert.match(out.text, /Layout:\n/)
})

/* ------------------------------------------------------------------ */
/* set_layout — rejection before dispatch                              */
/* ------------------------------------------------------------------ */

test('set_layout rejects the same view claimed by two panels, and points at the offending node', async () => {
  const h = harness()
  const out = await run(
    setLayout,
    { tree: { type: 'split', dir: 'row', children: [panelLeaf(['view_1']), panelLeaf(['view_1'])] } },
    h,
  )
  assert.equal(out.isError, true)
  assert.match(out.text, /BAD_REQUEST/)
  assert.match(out.text, /tree\.children\.1\.viewIds\.0/)
  assert.match(out.text, /View view_1 appears more than once/)
  assert.equal(h.sent.length, 0, 'an invalid tree never reaches the bus')
})

test('set_layout rejects a view listed twice inside one panel (P3)', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_1', 'view_1']) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /tree\.viewIds\.1/)
  assert.match(out.text, /appears more than once/)
  assert.equal(h.sent.length, 0)
})

test('set_layout rejects an activeViewId that is not one of the leaf\'s tabs (P2)', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_1'], { activeViewId: 'view_2' }) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /tree\.activeViewId/)
  assert.match(out.text, /not among this panel's viewIds/)
  assert.equal(h.sent.length, 0)
})

test('set_layout rejects a leaf holding more tabs than a panel allows (P5)', async () => {
  const h = harness()
  const open = Array.from({ length: MAX_PANEL_TABS }, () => ({ kind: 'query', connId: 'conn_1' }))
  const out = await run(setLayout, { tree: panelLeaf(['view_1'], { open }) }, h)
  assert.equal(out.isError, true)
  // Counted across both halves of the leaf: neither array alone exceeds the cap.
  assert.match(out.text, new RegExp(`at most ${String(MAX_PANEL_TABS)} tabs, got ${String(MAX_PANEL_TABS + 1)}`))
  assert.equal(h.sent.length, 0)
})

test('set_layout rejects a ratio whose length does not match the children', async () => {
  const h = harness()
  const out = await run(
    setLayout,
    { tree: { type: 'split', dir: 'row', ratio: [1], children: [panelLeaf(['view_1']), panelLeaf(['view_2'])] } },
    h,
  )
  assert.equal(out.isError, true)
  assert.match(out.text, /ratio/)
  assert.equal(h.sent.length, 0)
})

test('set_layout rejects the retired singular viewId rather than silently dropping it', async () => {
  const h = harness()
  // The hazard this guards: a stripped key would leave an *empty* leaf, and the
  // default unplaced:"close" would then close the very view the caller named.
  const out = await run(setLayout, { tree: { type: 'panel', viewId: 'view_1' } }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /viewId/)
  assert.equal(h.sent.length, 0)
})

test('set_layout rejects an unknown key on a split node too', async () => {
  const h = harness()
  const out = await run(
    setLayout,
    { tree: { type: 'split', dir: 'row', children: [panelLeaf(['view_1']), panelLeaf(['view_2'])], size: 3 } },
    h,
  )
  assert.equal(out.isError, true)
  assert.match(out.text, /size/)
  assert.equal(h.sent.length, 0)
})

test('set_layout names the views that do exist when one does not', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_404']) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /NOT_FOUND/)
  assert.match(out.text, /view_404 does not exist/)
  assert.match(out.text, /view_1, view_4, view_2, view_3/)
  assert.equal(h.sent.length, 0)
})

test('set_layout points at the tab position of the view that does not exist', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_1', 'view_404']) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /tab #2/, 'a leaf with several tabs must say which one broke')
  assert.equal(h.sent.length, 0)
})

test('set_layout refuses to invent a pinned panel id, and lists the real ones', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_1'], { panelId: 'panel_zz' }) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /BAD_REQUEST/)
  assert.match(out.text, /panel_zz does not exist/)
  assert.match(out.text, /panel_a, panel_b/)
  assert.equal(h.sent.length, 0)
})

test('set_layout checks the connection of an inline open leaf', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(undefined, { open: [{ kind: 'query', connId: 'conn_9' }] }) }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /conn_9 does not exist/)
  assert.equal(h.sent.length, 0)
})

test('set_layout honours expectRev and tells the caller the revision it is behind', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_1']), expectRev: 3 }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /CONFLICT/)
  assert.match(out.text, /expectRev 3 does not match the workspace revision 7/)
  assert.equal(h.sent.length, 0)

  const ok = harness(() => SET_LAYOUT_RESULT)
  await run(setLayout, { tree: panelLeaf(['view_1']), expectRev: 7 }, ok)
  assert.equal(ok.sent.length, 1, 'a matching revision goes through')
})

test('a rejection catalogues every tab, marking the visible one', async () => {
  const h = harness()
  const out = await run(setLayout, { tree: panelLeaf(['view_404']) }, h)
  // The commonest way to break P4 is to place a view another panel is already
  // holding out of sight, which a catalogue of visible tabs alone cannot explain.
  assert.match(out.text, /panel_a\[view_1\*, view_4\]/)
  assert.match(out.text, /view_4\(background tab of panel_a\)/)
  assert.match(out.text, /view_3\(unplaced\)/)
})

/* ------------------------------------------------------------------ */
/* move_view                                                           */
/* ------------------------------------------------------------------ */

const MOVE_RESULT = {
  viewId: 'view_1',
  fromPanelId: 'panel_a',
  toPanelId: 'panel_b',
  toIndex: 1,
  moved: true,
  closedViewIds: [],
  removedPanelIds: [],
  focusedPanel: 'panel_b',
}

const SPLIT_RESULT = {
  viewId: 'view_3',
  splitId: 'split_1',
  panelId: 'panel_new',
  fromPanelId: null,
  moved: true,
  removedPanelIds: [],
  focusedPanel: 'panel_new',
}

test('move_view defaults to a centre drop, which stacks the view as a new tab', async () => {
  const h = harness(() => MOVE_RESULT)
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_b' }, h)

  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.name, 'layout.moveView')
  // Explicitly 'stack', not left to the Command default: an unqualified move must
  // not be able to displace or close anything, and the dispatch says so.
  assert.deepEqual(h.sent[0]?.input, { viewId: 'view_1', toPanelId: 'panel_b', onOccupied: 'stack' })
  assert.match(out.text, /Moved view_1 from panel_a into panel_b as tab 1 of panel_b/)
  assert.doesNotMatch(out.text, /took its place/, 'stacking displaces nothing')
})

test('move_view still trades two views when swap is asked for by name', async () => {
  const h = harness(() => ({ ...MOVE_RESULT, swappedViewId: 'view_2' }))
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_b', onOccupied: 'swap' }, h)

  assert.deepEqual(h.sent[0]?.input, { viewId: 'view_1', toPanelId: 'panel_b', onOccupied: 'swap' })
  assert.match(out.text, /view_2 took its place in panel_a/)
})

test('move_view carries the tab position, and reports a same-panel move as a reorder', async () => {
  const h = harness(() => ({ ...MOVE_RESULT, fromPanelId: 'panel_a', toPanelId: 'panel_a', toIndex: 1 }))
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_a', index: 1 }, h)

  assert.deepEqual(h.sent[0]?.input, {
    viewId: 'view_1',
    toPanelId: 'panel_a',
    index: 1,
    onOccupied: 'stack',
  })
  // Sending a view to the panel it already occupies stopped being an unconditional
  // no-op: at a different index it is a tab reorder.
  assert.match(out.text, /Reordered view_1 within panel_a; it is now tab 1 of panel_a/)
})

test('move_view can slot a view in as a background tab', async () => {
  const h = harness(() => MOVE_RESULT)
  await run(moveView, { viewId: 'view_1', toPanelId: 'panel_b', activate: false }, h)
  assert.deepEqual(h.sent[0]?.input, {
    viewId: 'view_1',
    toPanelId: 'panel_b',
    activate: false,
    onOccupied: 'stack',
  })
})

test('move_view maps every edge zone through the same table the drag UI uses', async () => {
  const cases: [string, 'row' | 'col', 'before' | 'after'][] = [
    ['left', 'row', 'before'],
    ['right', 'row', 'after'],
    ['top', 'col', 'before'],
    ['bottom', 'col', 'after'],
  ]
  for (const [zone, dir, insert] of cases) {
    const h = harness(() => SPLIT_RESULT)
    await run(moveView, { viewId: 'view_3', toPanelId: 'panel_a', zone }, h)
    assert.equal(h.sent.length, 1, zone)
    assert.equal(h.sent[0]?.name, 'layout.splitWithView', zone)
    assert.deepEqual(h.sent[0]?.input, { viewId: 'view_3', panelId: 'panel_a', dir, insert }, zone)
  }
})

test('move_view refuses the tab arguments on an edge zone instead of ignoring them', async () => {
  for (const extra of [{ index: 1 }, { activate: false }, { onOccupied: 'swap' }]) {
    const h = harness(() => SPLIT_RESULT)
    const out = await run(moveView, { viewId: 'view_3', toPanelId: 'panel_a', zone: 'left', ...extra }, h)
    assert.equal(out.isError, true, JSON.stringify(extra))
    assert.match(out.text, /only applies to zone "center"/)
    assert.equal(h.sent.length, 0, 'a request the tool cannot honour never reaches the bus')
  }
})

test('move_view reports a no-op as a no-op, not as a failure', async () => {
  const h = harness(() => ({ ...MOVE_RESULT, moved: false, fromPanelId: 'panel_b', toIndex: 0 }))
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_b' }, h)
  assert.equal(out.isError, undefined)
  assert.match(out.text, /was already tab 0 of panel_b and already showing; nothing changed/)
})

test('move_view can address a view that currently has no panel', async () => {
  const h = harness(() => MOVE_RESULT)
  await run(moveView, { viewId: 'view_3', toPanelId: 'panel_a' }, h)
  assert.equal(h.sent.length, 1)
})

test('move_view rejects an unknown panel before dispatching', async () => {
  const h = harness()
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_zz' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /panel_zz does not exist/)
  assert.equal(h.sent.length, 0)
})

test('move_view rejects an unknown zone at the schema', async () => {
  const h = harness()
  const out = await run(moveView, { viewId: 'view_1', toPanelId: 'panel_b', zone: 'middle' }, h)
  assert.equal(out.isError, true)
  assert.equal(h.sent.length, 0)
})

/* ------------------------------------------------------------------ */
/* activate_view                                                       */
/* ------------------------------------------------------------------ */

test('activate_view brings a background tab forward and changes nothing else', async () => {
  const h = harness(() => ({
    viewId: 'view_4',
    panelId: 'panel_a',
    previousViewId: 'view_1',
    focusedPanel: 'panel_a',
  }))
  const out = await run(activateView, { viewId: 'view_4' }, h)

  assert.equal(out.isError, undefined)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0]?.name, 'view.activate')
  assert.deepEqual(h.sent[0]?.input, { viewId: 'view_4' })
  assert.match(out.text, /panel_a now shows view_4, instead of view_1/)
  assert.match(out.text, /view_1 is still open as a background tab/)
})

test('activate_view reports an already-visible tab as a no-op', async () => {
  const h = harness(() => ({
    viewId: 'view_1',
    panelId: 'panel_a',
    previousViewId: 'view_1',
    focusedPanel: 'panel_a',
  }))
  const out = await run(activateView, { viewId: 'view_1' }, h)
  assert.equal(out.isError, undefined)
  assert.match(out.text, /already the visible tab of panel_a; nothing changed/)
})

test('activate_view refuses a view that sits in no panel and names the repair', async () => {
  const h = harness()
  const out = await run(activateView, { viewId: 'view_3' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /CONFLICT/)
  assert.match(out.text, /sits in no panel/)
  assert.match(out.text, /move_view/)
  assert.equal(h.sent.length, 0)
})

test('activate_view refuses a view that does not exist', async () => {
  const h = harness()
  const out = await run(activateView, { viewId: 'view_404' }, h)
  assert.equal(out.isError, true)
  assert.match(out.text, /NOT_FOUND/)
  assert.equal(h.sent.length, 0)
})

/* ------------------------------------------------------------------ */
/* read_workspace                                                      */
/* ------------------------------------------------------------------ */

interface PanelPayload {
  panelId: string
  activeViewId: string | null
  views: { viewId: string; visible: boolean }[]
}

interface WorkspacePayload {
  rev: number
  layout?: LayoutNode
  panels?: PanelPayload[]
  unplacedViews?: { viewId: string }[]
}

test('read_workspace returns the structured layout tree without being asked', async () => {
  const h = harness()
  const out = await run(readWorkspace, {}, h)
  const data = out.data as WorkspacePayload

  assert.equal(data.rev, 7)
  assert.deepEqual(data.layout, LAYOUT, 'the tree an AI edits and sends back must be present')
  assert.deepEqual(data.panels?.map((p) => p.panelId), ['panel_a', 'panel_b'])
})

test('read_workspace lists every tab of a panel, in tab order, and names the visible one', async () => {
  const h = harness()
  const out = await run(readWorkspace, {}, h)
  const panels = (out.data as WorkspacePayload).panels
  assert.ok(panels, 'read_workspace must report panels')
  assert.equal(panels.length, 2)

  assert.deepEqual(panels[0].views.map((v) => v.viewId), ['view_1', 'view_4'])
  assert.equal(panels[0].activeViewId, 'view_1')
  assert.deepEqual(panels[0].views.map((v) => v.visible), [true, false])
  assert.deepEqual(panels[1].views.map((v) => v.viewId), ['view_2'])
  assert.equal(panels[1].activeViewId, 'view_2')
})

test('the layout outline shows the tab stack, so a hidden view cannot read as on screen', async () => {
  const h = harness()
  const out = await run(readWorkspace, {}, h)

  assert.match(out.text, /panel panel_a \[focused\] · 2 tabs/)
  assert.match(out.text, /#1 view_1 \[active\] · table · Table public\.view_1/)
  assert.match(out.text, /#2 view_4 · table · Table public\.view_4/)
  assert.doesNotMatch(out.text, /#2 view_4 \[active\]/)
})

test('read_workspace surfaces views that sit in no panel', async () => {
  const h = harness()
  const out = await run(readWorkspace, {}, h)
  const data = out.data as WorkspacePayload

  assert.deepEqual(data.unplacedViews?.map((v) => v.viewId), ['view_3'])
  assert.match(out.text, /unplaced: 1 view\(s\) — view_3/)
})

/* ------------------------------------------------------------------ */
/* Schema publication                                                  */
/* ------------------------------------------------------------------ */

test('set_layout publishes a JSON Schema, recursion and all', () => {
  // The MCP SDK converts inputSchema when it answers tools/list. A recursive
  // schema is the one shape that conversion can choke on, and a throw there takes
  // out the whole tool list, not just this tool.
  const json = z.toJSONSchema(setLayout.inputSchema, { io: 'input' })
  const text = JSON.stringify(json)
  assert.match(text, /"tree"/)
  assert.match(text, /panel leaf/, 'the node grammar reaches the model, not just the field names')
  assert.match(text, /"viewIds"/)
  assert.match(text, /"activeViewId"/)
  assert.match(text, /"unplaced"/)
  assert.match(text, /"additionalProperties":false/, 'a mistyped leaf key must fail, not be dropped')
  assert.ok(text.length < 64_000, 'the schema stays small enough to sit in a tool list')
})

test('move_view publishes its five drop zones and its tab arguments', () => {
  const text = JSON.stringify(z.toJSONSchema(moveView.inputSchema, { io: 'input' }))
  for (const zone of ['center', 'left', 'right', 'top', 'bottom']) {
    assert.match(text, new RegExp(`"${zone}"`))
  }
  for (const field of ['index', 'activate', 'onOccupied', 'stack', 'swap', 'replace']) {
    assert.match(text, new RegExp(`"${field}"`))
  }
})

test('activate_view publishes an input a model can fill from read_workspace alone', () => {
  const text = JSON.stringify(z.toJSONSchema(activateView.inputSchema, { io: 'input' }))
  assert.match(text, /"viewId"/)
  assert.match(text, /"focusPanel"/)
  assert.match(text, /visible/, 'the description ties the argument to what read_workspace reports')
})

test('read_workspace still accepts the retired withLayoutTree flag', async () => {
  const h = harness()
  const out = await run(readWorkspace, { withLayoutTree: false }, h)
  assert.equal(out.isError, undefined)
  assert.deepEqual((out.data as WorkspacePayload).layout, LAYOUT)
})
