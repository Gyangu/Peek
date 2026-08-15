import assert from 'node:assert/strict'
import { produce } from 'immer'
import { test } from 'node:test'
import {
  asConnId,
  asPanelId,
  asSplitId,
  collectPanels,
  createEmptyWorkspace,
  makePanel,
  type CommandInput,
  type CommandName,
  type CommandResultData,
  type CommandSource,
  type ConnectionState,
  type LayoutNode,
  type PanelId,
  type PostgresConnectionConfig,
  type Workspace,
} from '@peek/core'
import { queryHandlers } from '../handlers/query'
import { viewHandlers } from '../handlers/view'
import { createSeqIdFactory, type IdFactory } from '../ids'
import type { EffectIntent } from '../intents'
import type { CommandReducer, ReduceCtx } from '../types'

/* ==================================================================
 * A view a model opens must not land on top of the conversation that
 * asked for it.
 *
 * See docs/design/2026-08-03-agent-opens-beside-chat.md. The rule lives in
 * `resolveOpenTarget` (handlers/shared.ts), so it covers view.open, the query
 * view query.run opens when given no viewId, and conn.open's tree — all three
 * reach it through `openView`.
 *
 * The regression it exists for: the focused panel is the chat's own, tabs append
 * and activate, so "open public.orders" hid the message that asked for it.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const CONN_ID = asConnId('conn_1')
const ORDERS = { kind: 'relation', schema: 'public', name: 'orders' } as const

const P = (n: string): PanelId => asPanelId(`panel_${n}`)

/** An empty panel. Every view below is mounted by a command, never by the fixture. */
const panel = (n: string): LayoutNode => makePanel(P(n))

const row = (...children: LayoutNode[]): LayoutNode => ({
  type: 'split',
  id: asSplitId('split_root'),
  dir: 'row',
  ratio: children.map(() => 1 / children.length),
  children,
})

interface RunOutcome<K extends CommandName> {
  state: Workspace
  result: CommandResultData<K>
}

function runReduce<K extends CommandName>(
  state: Workspace,
  reduce: CommandReducer<K>,
  input: CommandInput<K>,
  source: CommandSource,
  ids: IdFactory = createSeqIdFactory('n'),
): RunOutcome<K> {
  const effects: EffectIntent[] = []
  const ctx: ReduceCtx = {
    source,
    commandId: 'cmd_test',
    now: 1_000,
    ids,
    plan: (intent) => {
      effects.push(intent)
    },
  }
  let result!: CommandResultData<K>
  const next = produce(state, (draft) => {
    result = reduce(draft, input, ctx)
    draft.rev += 1
  })
  return { state: next, result }
}

/**
 * A workspace with one connection, the layout the test needs, and a real
 * conversation in each of `chatPanels`.
 *
 * The chats are opened through `view.open` rather than written into `views` by
 * hand: the rule under test asks "does this panel hold a `kind: 'chat'` view",
 * and a hand-built fixture is exactly the kind that keeps answering yes after the
 * real chat state has moved on.
 *
 * The connection is left `connecting` unless a test asks otherwise — a view opens
 * against a connection that is not ready yet, and staying out of `ready` keeps
 * these tests about placement rather than about fetching.
 */
function scene(
  layout: LayoutNode,
  chatPanels: string[],
  opts: { focused?: string; ready?: boolean } = {},
): { state: Workspace; chat: string } {
  const ready = opts.ready === true
  const conn: ConnectionState = {
    id: CONN_ID,
    driverId: 'postgres',
    identity: 'postgres\u0000postgresql://postgres@localhost:5432/postgres',
    label: 'local',
    detail: 'postgresql://postgres@localhost:5432/postgres',
    endpoint: 'localhost:5432/postgres',
    config: PG_CONFIG,
    status: ready ? 'ready' : 'connecting',
    capabilities: ready ? ['tabularQuery'] : [],
  }
  const focused = P(opts.focused ?? chatPanels[0])
  let state: Workspace = {
    ...createEmptyWorkspace(focused),
    layout,
    focusedPanel: focused,
    connections: { [CONN_ID]: conn },
  }

  // One id factory across the whole fixture: a fresh one per chat would hand out
  // the same view id twice.
  const ids = createSeqIdFactory('c')
  const chats: string[] = []
  for (const panelName of chatPanels) {
    const run = runReduce<'view.open'>(
      state,
      viewHandlers['view.open'].reduce,
      { spec: { kind: 'chat' }, panelId: P(panelName), focus: false },
      'ui',
      ids,
    )
    state = run.state
    chats.push(String(run.result.viewId))
  }
  return { state, chat: chats[0] }
}

/**
 * Open a table. `ids` matters whenever a test opens twice: the real bus has one
 * factory, and a per-call one hands out the same view id again — which mounts
 * over the first view rather than beside it, and quietly proves nothing.
 */
const openTable = (
  state: Workspace,
  source: CommandSource,
  extra: Partial<CommandInput<'view.open'>> = {},
  ids: IdFactory = createSeqIdFactory('n'),
): RunOutcome<'view.open'> =>
  runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'table', connId: CONN_ID, ref: ORDERS }, ...extra },
    source,
    ids,
  )

/** Every panel's tab bar, in visual order. */
const tabs = (state: Workspace): string[][] => collectPanels(state.layout).map((p) => p.viewIds.map(String))

const panelIds = (state: Workspace): string[] => collectPanels(state.layout).map((p) => String(p.id))

/* ------------------------------------------------------------------ */
/* The redirect                                                        */
/* ------------------------------------------------------------------ */

test('a single column holding the conversation: the model gets a column of its own to the right', () => {
  const { state, chat } = scene(panel('a'), ['a'])
  const { state: next, result } = openTable(state, 'agent')

  assert.deepEqual(panelIds(next), ['panel_a', 'n_panel1'], 'a column was opened after the chat, not before')
  assert.deepEqual(tabs(next), [[chat], [String(result.viewId)]])
  assert.equal(result.panelId, 'n_panel1', 'the receipt names the pane it really landed in')
  assert.equal(next.focusedPanel, 'panel_a', 'the conversation keeps the cursor')
  assert.equal(next.layout.type === 'split' ? next.layout.dir : null, 'row', 'beside, not underneath')
})

test('an empty second column is used instead of splitting again', () => {
  const { state, chat } = scene(row(panel('a'), panel('b')), ['a'])
  const { state: next, result } = openTable(state, 'agent')

  assert.deepEqual(panelIds(next), ['panel_a', 'panel_b'], 'no new panel')
  assert.deepEqual(tabs(next), [[chat], [String(result.viewId)]])
  assert.equal(next.focusedPanel, 'panel_a')
})

test('an occupied second column takes the view as another tab rather than a new column', () => {
  const ids = createSeqIdFactory('n')
  const { state, chat } = scene(row(panel('a'), panel('b')), ['a'])
  const first = openTable(state, 'agent', {}, ids)
  const second = openTable(first.state, 'agent', {}, ids)

  assert.deepEqual(panelIds(second.state), ['panel_a', 'panel_b'])
  assert.deepEqual(tabs(second.state), [[chat], [String(first.result.viewId), String(second.result.viewId)]])
  const target = collectPanels(second.state.layout)[1]
  assert.equal(target.activeViewId, second.result.viewId, 'and it is the tab on top there')
  assert.equal(second.state.focusedPanel, 'panel_a', 'a run of opens never steals the cursor')
})

test('an empty column wins over an occupied one, wherever it sits', () => {
  const { state, chat } = scene(row(panel('a'), panel('b'), panel('c')), ['a'])
  const ids = createSeqIdFactory('n')
  const seeded = openTable(state, 'agent', {}, ids) // lands in b, the first free panel
  // b is now occupied and c is not, so the second open passes b over.
  const { state: next, result } = openTable(seeded.state, 'agent', {}, ids)

  assert.deepEqual(tabs(next), [[chat], [String(seeded.result.viewId)], [String(result.viewId)]])
})

test('a plain mcp client is held to the same rule as the embedded assistant', () => {
  const { state, chat } = scene(row(panel('a'), panel('b')), ['a'])
  const { state: next, result } = openTable(state, 'mcp')

  assert.deepEqual(tabs(next), [[chat], [String(result.viewId)]])
})

test('a run of opens lands in the same column instead of walking rightwards', () => {
  const ids = createSeqIdFactory('n')
  const { state, chat } = scene(panel('a'), ['a'])
  const first = runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'table', connId: CONN_ID, ref: ORDERS } },
    'agent',
    ids,
  )
  const second = runReduce<'view.open'>(
    first.state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'table', connId: CONN_ID, ref: ORDERS } },
    'agent',
    ids,
  )

  assert.equal(panelIds(second.state).length, 2, 'the second open splits nothing further')
  assert.deepEqual(tabs(second.state), [[chat], [String(first.result.viewId), String(second.result.viewId)]])
  assert.equal(second.state.focusedPanel, 'panel_a')
})

test('query.run without a viewId opens its query view beside the conversation too', () => {
  const { state, chat } = scene(panel('a'), ['a'], { ready: true })
  const { state: next } = runReduce<'query.run'>(
    state,
    queryHandlers['query.run'].reduce,
    { connId: CONN_ID, text: 'select 1' },
    'agent',
  )

  assert.equal(panelIds(next).length, 2)
  assert.deepEqual(tabs(next)[0], [chat], 'the conversation column is untouched')
  assert.equal(tabs(next)[1].length, 1)
  assert.equal(next.focusedPanel, 'panel_a')
})

test('a chat the model opens is redirected as well — it would cover the conversation just the same', () => {
  const { state, chat } = scene(panel('a'), ['a'])
  const { state: next, result } = runReduce<'view.open'>(
    state,
    viewHandlers['view.open'].reduce,
    { spec: { kind: 'chat' } },
    'agent',
  )

  assert.deepEqual(tabs(next), [[chat], [String(result.viewId)]])
})

/* ------------------------------------------------------------------ */
/* What the rule leaves alone                                          */
/* ------------------------------------------------------------------ */

test('a hand opens where a hand is looking, chat or no chat', () => {
  const { state, chat } = scene(panel('a'), ['a'])
  const { state: next, result } = openTable(state, 'ui')

  assert.deepEqual(panelIds(next), ['panel_a'], 'no column appears behind the user')
  assert.deepEqual(tabs(next), [[chat, String(result.viewId)]])
  assert.equal(next.focusedPanel, 'panel_a')
})

test('a named panel is obeyed, including the chat column itself', () => {
  const { state, chat } = scene(row(panel('a'), panel('b')), ['a'])
  const { state: next, result } = openTable(state, 'agent', { panelId: P('a') })

  assert.deepEqual(tabs(next), [[chat, String(result.viewId)], []])
  assert.equal(next.focusedPanel, 'panel_a', 'and focus follows an open that was not redirected')
})

test('a focused panel with no conversation in it is left as the target', () => {
  const ids = createSeqIdFactory('n')
  const { state, chat } = scene(row(panel('a'), panel('b')), ['a'], { focused: 'b' })
  const seeded = openTable(state, 'ui', { panelId: P('b') }, ids)
  const { state: next, result } = openTable(seeded.state, 'agent', {}, ids)

  assert.deepEqual(tabs(next), [[chat], [String(seeded.result.viewId), String(result.viewId)]])
  assert.equal(next.focusedPanel, 'panel_b', 'nothing was redirected, so focus moves as usual')
})

test('a window too full to divide still opens the view, as a tab in front of the chat', () => {
  // MAX_LAYOUT_PANELS columns, every one of them holding a conversation: nowhere
  // to redirect to, and no room to split.
  const names = Array.from({ length: 16 }, (_, i) => String(i))
  const { state, chat } = scene(row(...names.map((n) => panel(n))), names)
  const { state: next, result } = openTable(state, 'agent')

  assert.equal(panelIds(next).length, 16, 'the cap held')
  assert.deepEqual(tabs(next)[0], [chat, String(result.viewId)], 'opening the view still won')
  assert.equal(next.focusedPanel, 'panel_0', 'and a fallback open is not a redirect, so focus moved normally')
})
