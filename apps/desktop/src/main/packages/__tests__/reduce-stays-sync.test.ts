import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import {
  asConnId,
  asPanelId,
  createEmptyWorkspace,
  type Capability,
  type ConnId,
  type PackageViewAnswer,
  type PostgresConnectionConfig,
  type ViewOpenSpec,
} from '@peek/core'
import { CommandBus } from '../../bus/command-bus'
import {
  coreHandlers,
  createViewHandlers,
  type PackageViewSource,
  type ViewHandlerMap,
} from '../../bus/handlers'
import { createSeqIdFactory } from '../../bus/ids'
import { WorkspaceStore } from '../../store/workspace-store'
import type { CommandDeps } from '../../bus/deps'
import type { CommandHandlerMap } from '../../bus/types'

/* ==================================================================
 * Acceptance item 30: a reducer never returns a promise.
 *
 * A reducer runs inside a synchronous immer `produce`, and that synchrony is the
 * only thing making every check-and-set in the handlers atomic — "does this view
 * still exist, and if so update it" is safe because nothing can run between the
 * two halves. Package code moved out of main (§2.4bis e) and the values a
 * reducer used to compute now come from another process, so the pressure to
 * write `async reduce` is permanent and the failure it produces is not a failure:
 * the app keeps working, commands keep succeeding, and two of them interleave
 * once in a while and leave the workspace in a state neither one asked for.
 *
 * Nothing reports that. `CommandReducer`'s return type does not forbid a promise
 * either — `CommandResultData<K>` happens to accept an object, and a promise is
 * an object. So it is asserted, twice and from both sides:
 *
 *   - **statically**, over every handler the app registers, because the
 *     temptation lands on whichever reducer next needs a value from a host, and
 *     naming today's package-facing ones would leave that one uncovered;
 *   - **dynamically**, driving the two commands that do have a `prepare` in
 *     front of them with a source that answers on a later tick — the exact
 *     arrangement whose obvious implementation is an `await` inside the reducer.
 * ================================================================== */

const PG_CONFIG: PostgresConnectionConfig = {
  driverId: 'postgres',
  url: 'postgresql://postgres@localhost:5432/postgres',
}
const CAPS: Capability[] = ['introspect', 'collectionScan', 'tabularQuery']

const ANSWER: PackageViewAnswer = {
  fetch: { capability: 'tabularQuery', text: 'MATCH (n) RETURN n LIMIT 25' },
  title: 'orders',
  describe: 'a graph of orders',
}

/** A package host that is genuinely late: a macrotask, not a resolved promise. */
function slowSource(): PackageViewSource {
  return {
    answer: () =>
      new Promise<PackageViewAnswer>((resolve) => {
        setTimeout(() => {
          resolve(ANSWER)
        }, 5)
      }),
  }
}

/* ------------------------------------------------------------------ */
/* 1. Static: no registered reducer is an async function               */
/* ------------------------------------------------------------------ */

/**
 * The one member this scan reads.
 *
 * `CommandHandler<K>` is generic in its command, so the union `Object.entries`
 * produces is not a `CommandHandler` of anything — collapsing it would need an
 * assertion. Widening to the member under test needs none: every
 * `CommandReducer<K>` is a function, and whether it is an `AsyncFunction` is not
 * a question about K.
 */
interface ReducerHolder {
  reduce?: (...args: never[]) => unknown
}

/**
 * Every handler the app can register, flattened.
 *
 * `coreHandlers` is what `createBus` installs; the `view.*` factory is what main
 * swaps in once the package hosts exist, and it is the one whose reducers sit
 * downstream of a `prepare`. The chat and config factories replace their
 * `unavailable` twins already counted in `coreHandlers` and share their
 * reducers — what differs between the two is the effect layer.
 */
function allHandlers(): [string, ReducerHolder][] {
  const maps: CommandHandlerMap[] = [coreHandlers, createViewHandlers(slowSource())]
  const out: [string, ReducerHolder][] = []
  for (const map of maps) {
    for (const [name, handler] of Object.entries(map)) {
      if (handler !== undefined) out.push([name, handler])
    }
  }
  return out
}

describe('every reducer in the app reduces in one tick', () => {
  it('declares no reducer async', () => {
    const offenders: string[] = []
    let counted = 0

    for (const [name, handler] of allHandlers()) {
      const reduce = handler.reduce
      if (reduce === undefined) continue
      counted += 1
      // `read` and `prepare` may be async and several are; only `reduce` may not.
      if (reduce.constructor.name === 'AsyncFunction') offenders.push(name)
    }

    assert.deepEqual(offenders, [])
    assert.ok(counted >= 20, `the scan found ${String(counted)} reducers, which is too few to have run`)
  })
})

/* ------------------------------------------------------------------ */
/* 2. Dynamic: the two prepared commands still reduce synchronously    */
/* ------------------------------------------------------------------ */

interface Harness {
  bus: CommandBus
  /** What each wrapped reducer handed back, in call order. */
  returned: { name: string; value: unknown }[]
  queries: string[]
}

function deps(queries: string[]): CommandDeps {
  return {
    connections: {
      async open() {
        return { capabilities: CAPS, pid: 1 }
      },
      async close() {},
    },
    results: {
      async runQuery(req) {
        queries.push(req.text)
      },
      async scanCollection() {},
      async vectorSearch() {},
      async cancel() {
        return true
      },
    },
  }
}

/**
 * The real view handlers with their two reducers under observation.
 *
 * Written out per command rather than looped: `ViewHandlerMap` pins `reduce` to
 * one `CommandInput<K>` per key, and a loop over `Object.entries` would erase
 * exactly the K that makes the wrapper typecheck.
 */
function watched(real: ViewHandlerMap, returned: { name: string; value: unknown }[]): CommandHandlerMap {
  return {
    'view.open': {
      ...real['view.open'],
      reduce(draft, input, ctx) {
        const value = real['view.open'].reduce(draft, input, ctx)
        returned.push({ name: 'view.open', value })
        return value
      },
    },
    'view.update': {
      ...real['view.update'],
      reduce(draft, input, ctx) {
        const value = real['view.update'].reduce(draft, input, ctx)
        returned.push({ name: 'view.update', value })
        return value
      },
    },
  }
}

function harness(): Harness {
  const queries: string[] = []
  const returned: { name: string; value: unknown }[] = []
  const store = new WorkspaceStore(createEmptyWorkspace(asPanelId('panel_root')))
  const bus = new CommandBus({ store, deps: deps(queries), ids: createSeqIdFactory(), now: () => 1_000 })
  bus.registerAll(coreHandlers)
  bus.registerAll(watched(createViewHandlers(slowSource()), returned))
  return { bus, returned, queries }
}

async function connect(h: Harness): Promise<ConnId> {
  const res = await h.bus.dispatch('conn.open', { config: PG_CONFIG }, 'ui')
  assert.equal(res.ok, true)
  if (!res.ok) throw new Error('unreachable')
  return res.data.connId
}

describe('a package view waits before the reduction, never inside it', () => {
  it('opens and updates a package view without either reducer returning a promise', async () => {
    const h = harness()
    const connId = await connect(h)

    const opened = await h.bus.dispatch(
      'view.open',
      { spec: { kind: 'package', packageKind: 'graph', connId, state: { collection: 'orders' } } },
      'ui',
    )
    assert.equal(opened.ok, true)
    if (!opened.ok) throw new Error('unreachable')

    const updated = await h.bus.dispatch(
      'view.update',
      { viewId: opened.data.viewId, patch: { kind: 'package', state: { collection: 'shipments' } } },
      'ui',
    )
    assert.equal(updated.ok, true)

    assert.deepEqual(
      h.returned.map((r) => r.name),
      ['view.open', 'view.update'],
    )
    for (const { name, value } of h.returned) {
      assert.equal(value instanceof Promise, false, `${name} must reduce in the tick it was called in`)
    }

    // And the late answer did arrive — twice, once per command — otherwise a
    // reducer that ignored the package entirely would satisfy everything above.
    const text = ANSWER.fetch?.capability === 'tabularQuery' ? ANSWER.fetch.text : ''
    assert.deepEqual(h.queries, [text, text])
  })

  it('costs a table view nothing: its prepare answers without a promise', () => {
    const handlers = createViewHandlers(slowSource())
    const state = createEmptyWorkspace(asPanelId('panel_root'))
    const spec: ViewOpenSpec = {
      kind: 'table',
      connId: asConnId('conn_1'),
      ref: { kind: 'relation', schema: 'public', name: 'orders' },
    }

    // The reason the two `prepare`s are plain functions: an `async` one would
    // spend a microtask on every table patch in the app to answer "nothing".
    const prepared = handlers['view.open'].prepare?.(state, { spec })

    assert.equal(prepared instanceof Promise, false, 'a non-package view must not pay for the package path')
    assert.deepEqual(prepared, {})
  })
})
