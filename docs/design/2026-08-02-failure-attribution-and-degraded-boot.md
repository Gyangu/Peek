# The error centre stops guessing "who did this", and a degraded preload stops going unannounced

> 2026-08-02. Clearing two debt entries that are two halves of the same fault:
> `PLAN.md` §10's "the error centre's `source` attribution is a heuristic", and
> §11.2's "preload's `bootstrapMainWorld` failure degrades silently".
> One states something it does not know as though it did; the other knows
> something and does not say it.

---

## 1. What this fixes

### 1.1 The error centre is guessing, while the truth has been to hand all along

`errorLog.ts` tags every failure with a source. Two of its three rules are sound
(a toast's shape can only be produced by `notifyError`, which only the renderer
can call); the third is a guess:

```ts
function attributeStateError(): ErrorSource {
  return Date.now() - lastInflightAt <= UI_ATTRIBUTION_WINDOW_MS ? 'ui' : 'mcp'
}
```

"This window has issued no command in 1.5 seconds, so it must have been MCP."
That rule holds for **synchronous** failures and necessarily fails for
**asynchronous** ones: a query that times out after thirty seconds has an expired
`lastInflightAt` by the time it reaches the renderer whoever issued it — so **a
query the person timed out themselves is recorded as the agent's doing**.

The fix §10 records is:

> The truth does exist — main's command log carries `source` already — there is
> simply no channel carrying it to the renderer. Doing it properly needs a channel
> in `core/ipc.ts`, a member in preload, and assembly in main.

**That record overestimates the cost, and points at the wrong place.** Shipping
the command log across does not solve it: the `query.run` entry is a **success**
(the query went out), the failure happens thirty seconds later, and the renderer
would still have to correlate `resultId → commandId → source` itself. And that
correlation is exactly what "record the originator on the result" gets in one
step.

### 1.2 The degraded preload: the window opens, and query results never arrive

When `executeInMainWorld` in `preload/index.ts` fails, it takes the `fallback`
branch:

```ts
} catch (error) {
  bootstrapped = false
  console.error('[peek/preload] main-world bootstrap failed; …', error)
}
```

`console.error`'s audience is whoever has devtools open. For everyone else it
presents as: connections open, the tree expands, commands go out, the status bar
spins — **and only the query results never come**. The incident in §8.2 (preload
built with `keepNames` producing `ReferenceError: a is not defined`) took a long
time to find for exactly this reason.

Found along the way: the comment in `core/ipc.ts` describes a degradation that
**is not the one that happens**:

> The following members are **optional**: if preload's main-world bootstrap has to
> degrade (`executeInMainWorld` unavailable), only the control plane works.

But the fallback branch **does implement** `introspect` / `peekValue` /
`getKeyValue` (all through `internal.driverRpc`, an ordinary
`ipcRenderer.invoke` needing no main world). What actually disappears in the
degradation is `onResultPort` — the one thing that must be received in the main
world. The comment describes a degradation that cannot occur and omits the one
that does.

### 1.3 Boundary (explicitly not done)

- **No new IPC channel.** §1.1 has argued it is neither necessary nor
  sufficient.
- **The two toast attribution rules do not change.** They are sound, not guesses.
- **No "recover automatically after degrading".** A bootstrap failure is a hard
  build-time or run-time environment fault, and a restart is the answer;
  automatic retry would only turn a definite failure into an intermittent one.
- **`origin` is not exposed to MCP's `read_workspace`.** `snapshotWorkspace` is a
  hand-written projection, so leaving it out means it cannot leak. Showing an
  agent "which queries were mine" is a separate feature and needs thinking
  through on its own.

---

## 2. The plan

### 2.1 Record the originator on the thing being created

`ResultMeta` and `ConnectionState` each gain a field:

```ts
/** Who asked for this. Set once, at creation, by the Command Bus. */
origin?: CommandSource
```

One line at each of the two creation points:

| creation point | value |
|---|---|
| `beginResult` in `bus/handlers/shared.ts` | `ctx.source` |
| the `conn.open` reduce in `bus/handlers/conn.ts` | `ctx.source` |

The renderer's `harvestResults` / `harvestConnections` read it directly, and
`attributeStateError()`, `lastInflightAt`, `UI_ATTRIBUTION_WINDOW_MS` and that
`useBusyStore.subscribe` are deleted together.

**Why this is the truth rather than a different guess**: `origin` records who
caused this result set to exist. It is fixed at the moment of creation and never
changes afterwards, so a timeout thirty seconds later, a driver process crash, a
dropped connection — whenever it is looked up, the answer is the same. A `source`
landing on a patch could only answer "who turned it into an error", and that
answer is always `system` (which is what `result-sink.ts` writes), and useless to
whoever is reading it.

### 2.2 The field is optional, with a test behind it

`origin` is declared optional not because it might be missing, but because **the
repository has tests that hand-write `ConnectionState` literals**
(`connection-rows.test.ts` and others). Making it required would turn all of them
red, and that is noise unrelated to this change.

The cost is that the renderer has to handle "no origin". Not by guessing again,
but by:

1. Defaulting to `system` — **which is a definition, not a fallback**. `ui`, `mcp`
   and `agent` exhaust the cases where somebody asked, and an object created by no
   command belongs, by elimination, to peek itself.
2. Adding a test **through the command bus**: dispatch once under each of the four
   sources and assert the `origin` landing in the Workspace equals the issuing
   source. That makes "`origin` is necessarily present in production" a verified
   fact rather than an expectation.

### 2.3 `ErrorSource` collapses into `CommandSource`

The error centre's three values `ui | mcp | system` were invented locally.
Switching to core's `CommandSource` (`ui | mcp | agent | system`) leaves no second
enumeration, and — because
[`2026-08-02-agent-source-and-permission-scope.md`](2026-08-02-agent-source-and-permission-scope.md)
has just wired `agent` up properly — the panel can for the first time distinguish
**the embedded chat panel** from **an external MCP client**.

The labels change with it, because the original four words would now collide:

| source | old label | new label | meaning |
|---|---|---|---|
| `ui` | you | you | somebody clicked something in this window |
| `mcp` | agent | MCP | an external MCP client |
| `agent` | — | chat | peek's own embedded chat panel |
| `system` | peek | peek | peek itself: driver processes, timeouts, state sync |

The tooltip's "is inferred, not reported" is deleted — it used to be honest and
would now be a falsehood.

### 2.4 The degradation is forced out by the type and announced by the error centre

`PeekBridge` gains a **required** member:

```ts
/**
 * 'degraded' means the main-world bootstrap failed: the control plane works and
 * the data plane does not exist. Commands run and patches arrive; query results
 * never will.
 */
dataPlane: 'ok' | 'degraded'
```

Required is the point: both of preload's paths must supply a value, and the
compiler guarantees no third path quietly forgets.

The renderer reads it in `startErrorCollection()` — already the funnel for "where
this window can learn about failures". It raises an `error`-level toast, and the
existing toast subscription records it into the error centre (**without a separate
`recordError`**, which would record one event twice). So it is both immediately
visible (the toast) and reviewable afterwards (the error log plus the status bar
badge).

The comment §1.2 found wrong is corrected along the way: those optional members
**are available** on the degraded path, and what disappears is `onResultPort`.

### 2.5 Files involved

```
packages/core/src/workspace.ts            ResultMeta.origin / ConnectionState.origin
packages/core/src/ipc.ts                  PeekBridge.dataPlane + the corrected degradation comment
apps/desktop/src/preload/index.ts         both paths assign dataPlane
apps/desktop/src/main/bus/handlers/shared.ts   beginResult writes origin
apps/desktop/src/main/bus/handlers/conn.ts     conn.open writes origin
apps/desktop/src/renderer/components/error-center/errorLog.ts   heuristic deleted, origin read, degradation reported
apps/desktop/src/renderer/components/error-center/ErrorCenter.tsx  a fourth tab
apps/desktop/src/renderer/i18n/messages/{en,zh-CN}/app.ts       labels and tooltip
```

---

## 3. Trade-offs

**Why the command log is not pushed to the renderer** — see §1.1: it cannot answer
an asynchronous failure and would need a correlation done anyway, and the right
place for that correlation is the moment of creation. A side benefit is that this
route adds **not one IPC channel**.

**Why `source` is not added to `StatePatchMessage`** — `StoreChangeMeta` already
carries `source`; `ipc-main.ts` simply drops it when forwarding, and putting it
back is one line. But its meaning is "who changed the state", and for an
asynchronous failure that line is always `system`. The route is cheap and answers a
different question.

**Why `origin` is optional** — see §2.2. Required is prettier in the type system,
at the cost of turning red a batch of test literals unrelated to this change,
including work somebody has not yet committed. One test through the bus is a good
trade for that cost.

**Why the degradation uses a toast plus the error centre rather than a banner** —
a banner needs a new component, a new place in the layout and new dismissal
semantics, and laying down permanent interface for a state that never appears
under normal conditions is not a fair trade. The error centre is already where
"failures outlive their toast" live, and the status bar badge does not go away
until dismissed, which already satisfies "the user can see it".

**Why there is no automatic retry** — see §1.3.

---

## 4. Verification

Automatic:

```bash
pnpm --filter @peek/desktop test
pnpm typecheck
```

New assertions:

- dispatch `conn.open` once under each of the four `CommandSource` values, and
  `connections[id].origin` equals it;
- `query.run` / `view.open` take the same route, and `results[rid].origin` equals
  it;
- the name `attributeStateError` no longer exists in the repository (guarding
  against a half-deletion);
- `PeekBridge`'s `dataPlane` is required — one of preload's two paths omitting it
  fails to compile, which `pnpm typecheck` carries, with no separate test.

By hand (the degraded path cannot be produced in a unit test, because it needs a
real main world):

1. Temporarily change `contextBridge.executeInMainWorld({...})` in
   `preload/index.ts` to `(() => { throw new Error('forced') })()`;
2. `pnpm --filter @peek/desktop build && pnpm --filter @peek/desktop start`;
3. Expect: the window opens, the status bar's error badge shows 1 immediately, and
   a toast states that the data plane is unavailable; opening a connection and
   expanding the tree still work (the control plane is intact), and running a
   query stays in loading forever.
4. Change it back.
