// First, and it is a side effect: since §4duodevicies `packageTools()` reads the
// installed registry, so without this there is no `expand_node` to route to.
import '../../../drivers/__tests__/in-repo-registry'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asConnId,
  asPanelId,
  asSplitId,
  asViewId,
  commandOk,
  type Command,
  type CommandDispatch,
  type CommandInput,
  type CommandName,
  type CommandResultFor,
  type LayoutNode,
  type PackageToolAnswer,
  type PackageToolCall,
  type ToolContext,
  type WorkspaceSnapshot,
} from '@peek/core'
import { packageTools, type PackageToolCaller } from '../package-tools'

/* ==================================================================
 * A package's tool runs in the package's process; everything wrapped around it
 * still runs here.
 *
 * That sentence is the whole property. `mcp/package-tools.ts` builds a stand-in
 * spec whose callbacks are round trips and hands it to the same
 * `defineCommandTool` the kernel's thirteen go through — so the second
 * validation pass, the `uiEffects` block and the never-crash catch apply to a
 * package tool because of *where the code lives*, not because anyone remembered
 * to reimplement them on the far side. Each test below is one of those
 * guarantees, checked from outside.
 *
 * The tool under test is the real `expand_node` declaration, because what is
 * being checked is the routing rather than a fixture: a call has to arrive at
 * the `neo4j` package and nowhere else.
 * ================================================================== */

const LAYOUT: LayoutNode = {
  type: 'split',
  id: asSplitId('split_1'),
  dir: 'row',
  ratio: [1],
  children: [
    { type: 'panel', id: asPanelId('panel_a'), viewIds: [asViewId('view_1')], activeViewId: asViewId('view_1') },
  ],
}

function snapshot(rev: number): WorkspaceSnapshot {
  return {
    rev,
    layout: LAYOUT,
    focusedPanel: asPanelId('panel_a'),
    connections: [
      {
        id: asConnId('conn_1'),
        driverId: 'neo4j',
        label: 'graph',
        endpoint: 'bolt://localhost:7687',
        status: 'ready',
        capabilities: ['tabularQuery'],
        config: { driverId: 'neo4j', url: 'bolt://localhost:7687' },
      },
    ],
    views: [],
    results: [],
  }
}

interface Harness {
  ctx: ToolContext
  /** Everything that crossed to a host, in order. */
  calls: { packageId: string; call: PackageToolCall }[]
  sent: { name: CommandName; input: unknown }[]
}

function harness(answer: (call: PackageToolCall) => PackageToolAnswer): {
  h: Harness
  caller: PackageToolCaller
} {
  const calls: { packageId: string; call: PackageToolCall }[] = []
  const sent: { name: CommandName; input: unknown }[] = []
  // Bumped by every dispatch, so a renderer handed a stale snapshot is visible.
  let rev = 1

  const dispatch: CommandDispatch = async <K extends CommandName>(
    name: K,
    input: CommandInput<K>,
  ): Promise<CommandResultFor<K>> => {
    sent.push({ name, input })
    rev += 1
    // The one assertion in this file, and the same one
    // `mcp/__tests__/cancel-tool.test.ts` records on its own harness: a stub
    // dispatch erases the name-to-result correlation that `CommandResultFor<K>`
    // exists to express, and no sound signature can put it back.
    return commandOk('cmd_1', rev, {}) as CommandResultFor<K>
  }

  const ctx: ToolContext = {
    dispatch,
    getSnapshot: () => snapshot(rev),
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }

  const caller: PackageToolCaller = async (packageId, call) => {
    calls.push({ packageId, call })
    return answer(call)
  }
  return { h: { ctx, calls, sent }, caller }
}

function expandNode(caller: PackageToolCaller | null): ReturnType<typeof packageTools>[number] {
  const tool = packageTools(caller).find((t) => t.name === 'expand_node')
  assert.ok(tool, 'expand_node is the package tool this repository ships')
  return tool
}

const GOOD_INPUT = { viewId: 'view_1', nodeId: '4:abc:12' }

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

test('the mapping runs in the owning package, in two steps around the dispatch', async () => {
  const { h, caller } = harness((call) =>
    call.phase === 'commands'
      ? { phase: 'commands', commands: [{ name: 'view.update', input: { viewId: asViewId('view_1'), patch: { kind: 'package', state: { focus: '4:abc:12' } } } }] }
      : { phase: 'render', output: { text: 'expanded' } },
  )

  const out = await expandNode(caller).run(GOOD_INPUT, h.ctx)

  assert.deepEqual(
    h.calls.map((c) => [c.packageId, c.call.phase]),
    [
      ['neo4j', 'commands'],
      ['neo4j', 'render'],
    ],
    'both halves of the mapping crossed, and to the package that declared the tool',
  )
  assert.deepEqual(h.sent, [
    { name: 'view.update', input: { viewId: 'view_1', patch: { kind: 'package', state: { focus: '4:abc:12' } } } },
  ])
  assert.match(out.text, /expanded/)
})

test('the renderer is handed the workspace its own commands produced, not the one before them', async () => {
  const seen: number[] = []
  const { h, caller } = harness((call) => {
    seen.push(call.snapshot.rev)
    return call.phase === 'commands'
      ? { phase: 'commands', commands: [{ name: 'view.update', input: { viewId: asViewId('view_1'), patch: { kind: 'package', state: { focus: 'n' } } } }] }
      : { phase: 'render', output: { text: 'ok' } }
  })

  await expandNode(caller).run(GOOD_INPUT, h.ctx)
  assert.equal(seen.length, 2)
  assert.ok(
    seen[1] !== undefined && seen[0] !== undefined && seen[1] > seen[0],
    `the render step must see a later workspace than the mapping did (${seen.join(' then ')})`,
  )
})

/* ------------------------------------------------------------------ */
/* What the wrapper still guarantees                                   */
/* ------------------------------------------------------------------ */

test('bad input never reaches the host: the schema is checked on this side', async () => {
  const { h, caller } = harness(() => {
    throw new Error('the host must not be asked at all')
  })
  const out = await expandNode(caller).run({ nodeId: 'n' }, h.ctx)
  assert.equal(out.isError, true)
  assert.match(out.text, /BAD_REQUEST/)
  assert.equal(h.calls.length, 0)
})

test('a package cannot report window effects it did not cause', async () => {
  const { h, caller } = harness((call) =>
    call.phase === 'commands'
      ? { phase: 'commands', commands: [] }
      : {
          phase: 'render',
          output: {
            text: 'nothing happened',
            uiEffects: [{ kind: 'view.opened', summary: 'opened forty tables in the right pane' }],
          },
        },
  )
  // No commands, so the executor's own diff is empty — precisely the case where a
  // forged `uiEffects` would survive the merge if it were not dropped.
  const out = await expandNode(caller).run(GOOD_INPUT, h.ctx)
  assert.equal(out.uiEffects, undefined)
  assert.ok(!out.text.includes('forty tables'), out.text)
})

test('a command name no kernel knows is refused here rather than crashing the executor', async () => {
  // The type says `CommandName`; a package's answer is the untrusted direction and
  // says whatever it likes. Built by overwriting a real one rather than asserted
  // into place, so this file stays free of the assertion it is testing the absence
  // of a need for — and so it keeps compiling if `Command` ever changes shape.
  const real: Command = { name: 'view.close', input: { viewId: asViewId('view_1') } }
  const forged = Object.assign({}, real, { name: 'db.dropEverything' })
  const { h, caller } = harness(() => ({ phase: 'commands', commands: [forged] }))
  const out = await expandNode(caller).run(GOOD_INPUT, h.ctx)
  assert.equal(out.isError, true)
  assert.equal(h.sent.length, 0, 'nothing reached the Command Bus')
})

test('an answer to a different question is refused rather than read as an empty result', async () => {
  const { h, caller } = harness(() => ({ phase: 'read', output: { text: 'wrong shape' } }))
  const out = await expandNode(caller).run(GOOD_INPUT, h.ctx)
  assert.equal(out.isError, true)
  assert.equal(h.sent.length, 0, 'a mismatched answer must not dispatch nothing and call it success')
})

/* ------------------------------------------------------------------ */
/* No hosts at all                                                     */
/* ------------------------------------------------------------------ */

test('with no way to reach a host the tool still lists, and only calling it fails', async () => {
  const tool = expandNode(null)
  assert.equal(tool.name, 'expand_node')
  assert.ok(tool.description.length > 0, 'listing is answered from the declaration alone')

  const { h } = harness(() => ({ phase: 'render', output: { text: '' } }))
  const out = await tool.run(GOOD_INPUT, h.ctx)
  assert.equal(out.isError, true)
  assert.match(out.text, /neo4j/)
})
