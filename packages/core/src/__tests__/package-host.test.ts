import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { describe, test } from 'node:test'
import { z } from 'zod'
import { asConnId, asPanelId, asViewId } from '../ids'
import { defineToolSpec } from '../mcp-tools'
import type { ToolSpec, WorkspaceSnapshot } from '../index'
import { createPackageHostRuntime } from '../package-host'
import type {
  PackageHostChannel,
  PackageHostRequestOf,
  PackageHostResponse,
  PackageHostRuntimeOptions,
} from '../package-host'

/* ==================================================================
 * The package host runtime, over an ordinary `MessageChannel`.
 *
 * That it can be tested this way is the property `package-host.ts` is built for:
 * the transport is an interface naming only `postMessage` and `on('message')`,
 * so nothing here imports Electron and none of it needs a `utilityProcess`. A
 * `MessagePort` satisfies `PackageHostChannel` structurally, exactly as
 * `process.parentPort` does in the real thing.
 *
 * The subject is `callTool`, and specifically the line it draws: this process
 * runs a package's *mapping* and never its executor. Whether that mapping's
 * answer is then dispatched, validated a second time, or wrapped in a receipt is
 * main's business and is tested there
 * (`apps/desktop/src/main/mcp/__tests__/package-tool-routing.test.ts`).
 * ================================================================== */

const SNAPSHOT: WorkspaceSnapshot = {
  rev: 7,
  layout: { type: 'panel', id: asPanelId('panel_a'), viewIds: [], activeViewId: null },
  focusedPanel: asPanelId('panel_a'),
  connections: [],
  views: [],
  results: [],
}

interface Host {
  call<M extends 'display' | 'viewAnswer' | 'collectRef' | 'callTool'>(
    req: Omit<PackageHostRequestOf<M>, 'kind' | 'rid'>,
  ): Promise<PackageHostResponse>
  close(): void
}

function host(options: PackageHostRuntimeOptions): Host {
  const { port1, port2 } = new MessageChannel()
  const channel: PackageHostChannel = {
    postMessage: (msg) => {
      port2.postMessage(msg)
    },
    on: (_event, listener) => {
      port2.on('message', (data: unknown) => {
        listener({ data })
      })
    },
    start: () => {
      port2.start()
    },
  }
  createPackageHostRuntime(channel, options)

  let rid = 0
  return {
    async call(req) {
      rid += 1
      const mine = rid
      const answer = new Promise<PackageHostResponse>((resolve) => {
        const onMessage = (data: PackageHostResponse): void => {
          if (data.rid !== mine) return
          port1.off('message', onMessage)
          resolve(data)
        }
        port1.on('message', onMessage)
      })
      port1.postMessage({ kind: 'req', rid: mine, ...req })
      return await answer
    },
    close() {
      port1.close()
      port2.close()
    },
  }
}

/**
 * The mapping under test, in the two shapes main asks about: with a renderer and
 * without. Two declarations rather than one with a conditional `render`, because
 * `defineToolSpec` infers the input type from `inputSchema` and a spread in the
 * object literal is exactly what stops it.
 */
const EXPAND = defineToolSpec({
  kind: 'command',
  name: 'expand',
  description: 'expand something',
  inputSchema: z.object({ id: z.string() }),
  toCommands(input, ctx) {
    return [
      {
        name: 'view.update',
        input: {
          // The snapshot that travelled with the request, read back out: the
          // mapping's whole view of the world is what main sent, not anything it
          // could go and fetch.
          viewId: asViewId(`view_${String(ctx.getSnapshot().rev)}`),
          patch: { kind: 'package', state: { focus: input.id } },
        },
      },
    ]
  },
  render(outcomes, input, ctx) {
    return {
      text: `${input.id} · ${String(outcomes.length)} outcome(s) · rev ${String(ctx.getSnapshot().rev)}`,
    }
  },
})

const EXPAND_NO_RENDER = defineToolSpec({
  kind: 'command',
  name: 'expand',
  description: 'expand something, receipt left to the kernel',
  inputSchema: z.object({ id: z.string() }),
  // The commands are beside the point here; what this declaration is for is the
  // absent `render`.
  toCommands: () => [],
})

function toolsWith(options: { render: boolean }): readonly ToolSpec[] {
  return [options.render ? EXPAND : EXPAND_NO_RENDER]
}

describe('callTool', () => {
  test('the commands phase runs the package mapping and hands back what it produced', async (t) => {
    const h = host({ tools: toolsWith({ render: true }) })
    t.after(h.close)
    const res = await h.call({
      method: 'callTool',
      params: { name: 'expand', phase: 'commands', args: { id: 'n1' }, snapshot: SNAPSHOT },
    })
    assert.equal(res.ok, true, res.ok ? '' : res.error.message)
    assert.ok(res.ok)
    assert.deepEqual(res.result, {
      phase: 'commands',
      commands: [
        {
          name: 'view.update',
          input: { viewId: 'view_7', patch: { kind: 'package', state: { focus: 'n1' } } },
        },
      ],
    })
  })

  test('the render phase gets the outcomes, and a tool without a renderer says so instead of inventing one', async (t) => {
    const withRender = host({ tools: toolsWith({ render: true }) })
    t.after(withRender.close)
    const rendered = await withRender.call({
      method: 'callTool',
      params: {
        name: 'expand',
        phase: 'render',
        args: { id: 'n1' },
        snapshot: SNAPSHOT,
        outcomes: [{ name: 'view.update', ok: true }],
      },
    })
    assert.ok(rendered.ok)
    assert.deepEqual(rendered.result, { phase: 'render', output: { text: 'n1 · 1 outcome(s) · rev 7' } })

    const without = host({ tools: toolsWith({ render: false }) })
    t.after(without.close)
    const plain = await without.call({
      method: 'callTool',
      params: { name: 'expand', phase: 'render', args: { id: 'n1' }, snapshot: SNAPSHOT, outcomes: [] },
    })
    assert.ok(plain.ok)
    // `null`, not an empty receipt: main falls back to its own default renderer,
    // which is what a kernel tool with no `render` gets too.
    assert.deepEqual(plain.result, { phase: 'render', output: null })
  })

  test('a package cannot reach the Command Bus from here', async (t) => {
    const sneaky = defineToolSpec({
      kind: 'command',
      name: 'sneaky',
      description: 'dispatches on its own behalf',
      inputSchema: z.object({}),
      async toCommands(_input, ctx) {
        await ctx.dispatch('conn.close', { connId: asConnId('conn_1') }, 'ui')
        return []
      },
    })
    const h = host({ tools: [sneaky] })
    t.after(h.close)

    const res = await h.call({
      method: 'callTool',
      params: { name: 'sneaky', phase: 'commands', args: {}, snapshot: SNAPSHOT },
    })
    assert.equal(res.ok, false)
    assert.ok(!res.ok)
    // The point is not the error code but that there is no channel at all: a tool
    // that wants a Command must return it and let main decide the source.
    assert.match(res.error.message, /may not dispatch Commands/)
  })

  test('a mapping that throws is a response, not an exit — the next call is still answered', async (t) => {
    const angry = defineToolSpec({
      kind: 'command',
      name: 'angry',
      description: 'throws',
      inputSchema: z.object({}),
      toCommands() {
        throw new Error('no')
      },
    })
    const h = host({ tools: [angry, ...toolsWith({ render: true })] })
    t.after(h.close)

    const failed = await h.call({
      method: 'callTool',
      params: { name: 'angry', phase: 'commands', args: {}, snapshot: SNAPSHOT },
    })
    assert.equal(failed.ok, false)

    const after = await h.call({
      method: 'callTool',
      params: { name: 'expand', phase: 'commands', args: { id: 'n2' }, snapshot: SNAPSHOT },
    })
    assert.equal(after.ok, true, 'the runtime kept answering')
  })

  test('a tool this package does not have is NOT_FOUND rather than silence', async (t) => {
    const h = host({ tools: toolsWith({ render: true }) })
    t.after(h.close)
    const res = await h.call({
      method: 'callTool',
      params: { name: 'nobody', phase: 'commands', args: {}, snapshot: SNAPSHOT },
    })
    assert.ok(!res.ok)
    assert.equal(res.error.code, 'NOT_FOUND')
  })
})
