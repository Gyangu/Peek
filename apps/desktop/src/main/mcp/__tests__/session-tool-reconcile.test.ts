import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { asPanelId, asSplitId } from '@peek/core'
import { reconcileSessionTools, registerTools, type RegisteredPeekTool } from '../registry'
import type { PeekTool, ToolContext } from '../types'

/* ==================================================================
 * A `tools/list_changed` that is followed by a different list.
 *
 * Reading the installed registry (`package-tools-follow-registry.test.ts`) is
 * only half of acceptance 13's first sentence, and §4sedecies(b) measured the
 * other half without naming it: re-handshaking did not help either. The reason
 * is here rather than there — the MCP SDK stores a session's tool table when the
 * session is created, so a session that outlived an uninstall keeps answering
 * `tools/list` out of that table however the registry has moved.
 *
 * `refreshToolDescriptions` was the earlier version of this problem, one field
 * narrower: §4quaterdecies(d) found the *descriptions* frozen at session start
 * and fixed those. This is the same failure one level up, in the set itself.
 *
 * ## The fake, and what it is allowed to be
 *
 * `McpServer` is faked down to `registerTool`, because the three things under
 * test are which names it is asked to register, which handles are removed, and
 * which descriptions are written back — all of them observable at that one
 * method. Standing up a real `McpServer` would need a transport and would move
 * the question from "does peek reconcile" to "does the SDK store a map".
 * ================================================================== */

interface FakeServer {
  server: McpServer
  /** Every name `registerTool` was called with, in order, across the whole test. */
  registered: string[]
  /** Every name whose handle had `remove()` called on it. */
  removed: string[]
  /** The table the SDK would answer `tools/list` from: name → stored description. */
  table: Map<string, string>
}

function fakeServer(): FakeServer {
  const registered: string[] = []
  const removed: string[] = []
  const table = new Map<string, string>()

  const server = {
    registerTool(name: string, config: { description: string }): RegisteredTool {
      if (table.has(name)) throw new Error(`Tool ${name} is already registered`)
      registered.push(name)
      table.set(name, config.description)
      const handle = {
        // The SDK stores the string; peek writes to this field rather than
        // through `update()` so that one install is not fourteen notifications.
        set description(next: string) {
          table.set(name, next)
        },
        get description(): string {
          return table.get(name) ?? ''
        },
        remove() {
          removed.push(name)
          table.delete(name)
        },
      }
      return handle as unknown as RegisteredTool
    },
  }
  return { server: server as unknown as McpServer, registered, removed, table }
}

/**
 * A tool whose description is a getter, like every tool peek registers.
 *
 * `describe` is read at call time, which is what makes "the description moved
 * while the session was open" expressible at all — see `baseFields` in
 * `executor.ts` for why the kernel's own tools are built that way.
 */
function tool(name: string, describe: () => string): PeekTool {
  return {
    name,
    get description() {
      return describe()
    },
    inputSchema: z.object({}),
    readOnly: true,
    run: async () => ({ text: name }),
  }
}

function ctx(): ToolContext {
  return {
    dispatch: async () => {
      throw new Error('no tool in this file reaches the bus')
    },
    getSnapshot: () => ({
      rev: 1,
      layout: {
        type: 'split',
        id: asSplitId('split_1'),
        dir: 'row',
        ratio: [1],
        children: [{ type: 'panel', id: asPanelId('panel_a'), viewIds: [], activeViewId: null }],
      },
      focusedPanel: asPanelId('panel_a'),
      connections: [],
      views: [],
      results: [],
    }),
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }
}

/** A session that opened holding `tools`, ready to be reconciled against another set. */
function openSession(fake: FakeServer, tools: readonly PeekTool[]): RegisteredPeekTool[] {
  return registerTools(fake.server, tools, ctx())
}

describe('reconciling one live session against a new tool set', () => {
  test('a package uninstalled while the session was open loses its tools', () => {
    const fake = fakeServer()
    const kernel = tool('run_query', () => 'run a query')
    const packaged = tool('expand_node', () => 'expand a graph node')
    const session = openSession(fake, [kernel, packaged])

    const after = reconcileSessionTools(fake.server, session, [kernel], ctx())

    assert.deepEqual(fake.removed, ['expand_node'])
    assert.deepEqual([...fake.table.keys()], ['run_query'])
    assert.deepEqual(
      after.map((entry) => entry.tool.name),
      ['run_query'],
    )
  })

  test('a package installed while the session was open gains its tools', () => {
    const fake = fakeServer()
    const kernel = tool('run_query', () => 'run a query')
    const packaged = tool('expand_node', () => 'expand a graph node')
    const session = openSession(fake, [kernel])

    const after = reconcileSessionTools(fake.server, session, [kernel, packaged], ctx())

    assert.deepEqual(fake.registered, ['run_query', 'expand_node'])
    assert.deepEqual(fake.removed, [])
    assert.deepEqual(
      after.map((entry) => entry.tool.name),
      ['run_query', 'expand_node'],
    )
  })

  test('a surviving tool keeps its registration and is not registered twice', () => {
    const fake = fakeServer()
    const kernel = tool('run_query', () => 'run a query')
    const session = openSession(fake, [kernel])

    // The SDK throws on a duplicate name, so re-registering a survivor would not
    // be a quiet inefficiency — it would take the whole reconciliation down and,
    // with it, the notification.
    reconcileSessionTools(fake.server, session, [kernel], ctx())

    assert.deepEqual(fake.registered, ['run_query'])
    assert.deepEqual(fake.removed, [])
  })

  test('a description that moved is written back, for the tools that stayed', () => {
    const fake = fakeServer()
    let databases = 'postgres'
    // `connect` is the real instance of this: its description lists a config
    // example per installed driver (§4terdecies(e)).
    const connect = tool('connect', () => `open a connection to ${databases}`)
    const session = openSession(fake, [connect])
    assert.equal(fake.table.get('connect'), 'open a connection to postgres')

    databases = 'postgres, neo4j'
    reconcileSessionTools(fake.server, session, [connect], ctx())

    assert.equal(fake.table.get('connect'), 'open a connection to postgres, neo4j')
  })

  test('a tool replaced under the same name is taken from the new set', () => {
    const fake = fakeServer()
    const before = tool('expand_node', () => 'version 1')
    const after = tool('expand_node', () => 'version 2')
    const session = openSession(fake, [before])

    const table = reconcileSessionTools(fake.server, session, [after], ctx())

    // A package reinstalled at another version keeps its tool names, and
    // everything else about them may have moved. Matching by name and then
    // keeping the *old* tool would leave the session running the old mapping.
    assert.equal(table[0]?.tool, after)
    assert.equal(fake.table.get('expand_node'), 'version 2')
  })
})
