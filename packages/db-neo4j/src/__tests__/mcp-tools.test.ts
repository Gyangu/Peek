import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isPeekError,
  type CommandToolSpec,
  type ConnId,
  type PanelId,
  type ToolContext,
  type ToolSpec,
  type ViewId,
  type ViewSummary,
  type WorkspaceSnapshot,
} from '@peek/core'
import { MAX_DEPTH } from '../limits'
import { neo4jMcpTools } from '../mcp-tools'

/**
 * The MCP tool this package contributes. No server involved — everything here is
 * the mapping from a tool call onto a Command, which is the whole of what a tool
 * is allowed to be.
 *
 * What is worth testing is not the happy path (one `view.update`, no branches)
 * but the two refusals. A tool that maps a bad input onto a Command anyway hands
 * the Command Bus a well-formed request to do the wrong thing, and the error the
 * caller eventually sees is about a discriminated union rather than about the
 * view they named.
 */

function view(over: Partial<ViewSummary> = {}): ViewSummary {
  return {
    id: 'view_g' as ViewId,
    kind: 'package',
    packageKind: 'graph',
    connId: 'conn_1' as ConnId,
    panelId: 'panel_1' as PanelId,
    tabIndex: 0,
    visible: true,
    title: 'Graph',
    status: 'idle',
    describe: 'Neo4j graph across all labels, up to 100 nodes',
    ...over,
  }
}

function ctxWith(views: ViewSummary[]): ToolContext {
  const snapshot = {
    rev: 1,
    layout: { type: 'panel', id: 'panel_1' as PanelId, viewIds: views.map((v) => v.id) },
    focusedPanel: 'panel_1' as PanelId,
    connections: [],
    views,
    results: [],
  } as unknown as WorkspaceSnapshot
  return {
    dispatch: () => Promise.reject(new Error('no command should be dispatched from a mapping test')),
    getSnapshot: () => snapshot,
    logger: { log: () => undefined },
    now: () => 0,
    sleep: () => Promise.resolve(),
  }
}

function commandTool(name: string): CommandToolSpec {
  const spec: ToolSpec | undefined = neo4jMcpTools.find((t) => t.name === name)
  assert.ok(spec !== undefined, `this package declares no tool called ${name}`)
  assert.equal(spec.kind, 'command', `${name} must be a command tool`)
  return spec as CommandToolSpec
}

describe('the tools this package contributes', () => {
  it('declares exactly the one the design names, and no kernel verb', () => {
    // A package tool that shadowed `run_query` or `set_layout` would be a silent
    // takeover — `collectTools` throws on it, and this is the cheaper signal.
    assert.deepEqual(
      neo4jMcpTools.map((t) => t.name),
      ['expand_node'],
    )
  })

  it('names itself in snake_case, which is what the MCP surface is spelled in', () => {
    for (const tool of neo4jMcpTools) {
      assert.match(tool.name, /^[a-z][a-z_]*$/)
      assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can act on`)
    }
  })
})

describe('expand_node maps onto view.update, and refuses rather than mapping badly', () => {
  it('writes the node id into `focus`, which is the key graph.ts reads', async () => {
    const tool = commandTool('expand_node')
    const commands = await tool.toCommands({ viewId: 'view_g', nodeId: '4:db:7' }, ctxWith([view()]))
    assert.equal(commands.length, 1)
    const [cmd] = commands
    assert.equal(cmd?.name, 'view.update')
    assert.deepEqual(cmd?.input, {
      viewId: 'view_g',
      patch: { kind: 'package', state: { focus: '4:db:7', label: null } },
    })
  })

  it('clears `label`, because focus wins over it and a stale filter would still be in the title', async () => {
    // `composeGraphQuery` ignores `label` once `focus` is set, so leaving it
    // would change nothing about the rows and everything about what the tab
    // claims to be showing.
    const tool = commandTool('expand_node')
    const [cmd] = await tool.toCommands({ viewId: 'view_g', nodeId: 'n' }, ctxWith([view()]))
    const state = (cmd?.input as { patch: { state: Record<string, unknown> } }).patch.state
    assert.equal(state['label'], null)
  })

  it('passes depth through only when it was given', async () => {
    const tool = commandTool('expand_node')
    const withDepth = await tool.toCommands({ viewId: 'view_g', nodeId: 'n', depth: 2 }, ctxWith([view()]))
    const state = (withDepth[0]?.input as { patch: { state: Record<string, unknown> } }).patch.state
    assert.equal(state['depth'], 2)

    const without = await tool.toCommands({ viewId: 'view_g', nodeId: 'n' }, ctxWith([view()]))
    const bare = (without[0]?.input as { patch: { state: Record<string, unknown> } }).patch.state
    assert.ok(!('depth' in bare), 'an absent depth must leave the view on whatever it had')
  })

  it('caps depth in the schema, at the same number graph.ts clamps to', () => {
    // Two ceilings that must be one: the schema refuses `depth: 9` with a
    // message, `readGraphState` would silently clamp it. Refusing is the better
    // failure, but only if the numbers agree.
    const tool = commandTool('expand_node')
    assert.equal(tool.inputSchema.safeParse({ viewId: 'v', nodeId: 'n', depth: MAX_DEPTH }).success, true)
    assert.equal(
      tool.inputSchema.safeParse({ viewId: 'v', nodeId: 'n', depth: MAX_DEPTH + 1 }).success,
      false,
    )
    assert.equal(tool.inputSchema.safeParse({ viewId: 'v', nodeId: 'n', depth: 0 }).success, false)
    assert.equal(tool.inputSchema.safeParse({ viewId: 'v', nodeId: 'n', depth: 1.5 }).success, false)
  })

  it('requires both ids, since neither has a sensible default', () => {
    const tool = commandTool('expand_node')
    assert.equal(tool.inputSchema.safeParse({ nodeId: 'n' }).success, false)
    assert.equal(tool.inputSchema.safeParse({ viewId: 'v' }).success, false)
    assert.equal(tool.inputSchema.safeParse({ viewId: '', nodeId: 'n' }).success, false)
  })

  it('refuses an unknown viewId as NOT_FOUND, and says where to get one', async () => {
    const tool = commandTool('expand_node')
    await assert.rejects(
      async () => tool.toCommands({ viewId: 'view_missing', nodeId: 'n' }, ctxWith([view()])),
      (err: unknown) => {
        assert.ok(isPeekError(err))
        assert.equal(err.code, 'NOT_FOUND')
        assert.match(err.message, /read_workspace/)
        return true
      },
    )
  })

  it('refuses a view of another kind, naming the kind it actually is', async () => {
    // The point of checking here rather than letting `view.update` reject it: a
    // kind mismatch reported by the Command Bus is a message about a
    // discriminated union. This one tells the caller what it hit and what to do.
    const tool = commandTool('expand_node')
    const table = view({ kind: 'table', packageKind: undefined })
    await assert.rejects(
      async () => tool.toCommands({ viewId: 'view_g', nodeId: 'n' }, ctxWith([table])),
      (err: unknown) => {
        assert.ok(isPeekError(err))
        assert.equal(err.code, 'BAD_REQUEST')
        assert.match(err.message, /table view/)
        assert.match(err.message, /open_view/)
        return true
      },
    )
  })

  it('refuses another package view, not just a built-in one', async () => {
    // The near-miss worth pinning: `kind === 'package'` is true for every package
    // view there will ever be, so testing only against a table would leave the
    // check passing on a `documents` view from some other package.
    const tool = commandTool('expand_node')
    const other = view({ packageKind: 'documents' })
    await assert.rejects(
      async () => tool.toCommands({ viewId: 'view_g', nodeId: 'n' }, ctxWith([other])),
      (err: unknown) => {
        assert.ok(isPeekError(err))
        assert.equal(err.code, 'BAD_REQUEST')
        assert.match(err.message, /documents view/)
        return true
      },
    )
  })
})
