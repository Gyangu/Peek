# The namespace cache follows the connection's lifecycle

## 1. What this fixes

### The symptom

Click any connection in the sidebar (or "Connect" in the connect dialog) and the
object tree that just opened immediately reads:

> Failed to load: Connection conn_xxx is connecting and cannot run this yet

Clicking "Refresh" once fixes it. **Every driver, every connection reproduces
it** — this is not intermittent.

### The immediate chain

1. `Sidebar.tsx` / `ConnectDialog.tsx` dispatch `conn.open` with
   `openTree: true`.
2. The reduce in `bus/handlers/conn.ts` does two things in **the same tick**:
   sets the connection to `connecting` (the real handshake is an async effect
   queued by `ctx.plan({type:'connect'})`), and calls
   `openView(draft, {kind:'tree'})`.
3. The new view is broadcast to the renderer, and `TreeLevel` calls
   `loadChildren` unconditionally from a `useEffect` the moment it mounts.
4. The connection is still `connecting`, so `ConnectionManager.requireReady`
   throws `error.conn.notReady`.
5. `namespaceStore` writes that error into the cache as `status:'error'`.
   **Nothing replays it once the connection turns `ready`**, and the
   `useEffect`'s `[connId, parentId]` dependencies have not changed, so the error
   hangs there until the user refreshes by hand.

The comment at `conn.ts:59` says "once connected the renderer fetches the first
level" — the renderer has never waited for connected. The comment describes the
design's intent, which the code never implemented.

### The root cause

Not "TreeView is missing an if". The root cause is:

> **`namespaceStore` is a cache with no relationship to the connection's
> lifecycle whatsoever.**

It knows two triggers only: lazy loading when a component mounts, and the user
clicking refresh (a literal implementation of PLAN §8's "tree lazy loads +
caches + invalidated by manual refresh"). It knows neither **when a connection
becomes usable** nor **when one disappears or is replaced**. Contrast
`pruneResults` in `state/sync.ts` — the result cache subscribes to workspace
changes, and the namespace cache has no such wire.

One root cause, three symptoms, of which the user reported only the first:

| # | symptom | today |
|---|---|---|
| 1 | introspect is issued while connecting, and a transient error is cached as terminal | the reported one |
| 2 | after a connection closes, its tree cache stays in the renderer forever | memory only grows (`pruneResults` has the equivalent cleanup; this does not) |
| 3 | after reconnecting under the same connId, the tree still holds the previous connection's data | stale data shown silently |

### Boundary (not done here)

- **`conn.open`'s timing does not change.** Opening the tree while connecting is
  right: the user clicked connect and should see the panel at once, not stare at
  nothing waiting for a handshake. What needs fixing is how the tree behaves
  while it waits, not deferring the view.
- No automatic polling, automatic reconnection or background prefetching for the
  object tree.
- No change to any `introspect` logic on the main side (`requireReady` refusing an
  unready connection is correct; it is the last gate and should not yield to a
  timing problem in the renderer).

## 2. The plan

Hang the namespace cache off the connection state, in three changes.

### 2.1 `NodesStatus` gains `'waiting'`

```ts
export type NodesStatus = 'waiting' | 'loading' | 'ready' | 'error'
```

Separating the meanings:

- `waiting` — the connection is not ready, and **the request was never sent**;
- `loading` — a request is in flight;
- `error` — the database or driver genuinely refused (permissions, no such
  database, …), a terminal state the user has to deal with.

"The connection is not up yet" stops masquerading as "failed to load".

### 2.2 A connection gate in front of `loadChildren`

`loadChildren` opens by reading that connection's `status` from
`readWorkspace()`, and if it is not `ready`, writes a `waiting` record and
returns without touching the bridge.

The gate goes in the store rather than in `TreeView` because `loadChildren` has
three call sites (mount, expanding a node, refresh) and will have more; putting it
in the component copies one precondition three times and protects only "the tree
currently mounted".

A connection absent from the workspace (not yet broadcast, or already closed) is
treated as not ready too.

### 2.3 `state/sync.ts` subscribes to connection state transitions

Alongside the existing `pruneResults`, a new subscription keeps a `connId →
status` snapshot from the previous round and diffs the transitions:

- **Into `ready`** (a first `connecting → ready`, or a reconnecting
  `error → ready`): call `loadChildren(connId, parentId, true)` for **every level
  already present** under that connection. `refresh=true` bypasses the cache
  check, which refetches the connection's tree wholesale.
  - On a first connection the cache holds only a `waiting` root level → the effect
    is "the handshake finished, load the root level", and symptom 1 is gone.
  - On a reconnection the cache holds the previous connection's data → the effect
    is "the data source changed, refetch", and symptom 3 is gone.
  - With nothing in the cache (nobody has opened the tree) → nothing happens, and
    the tree loads itself when opened.
- **Disappearing from the workspace** (`conn.close`): `invalidateConnection`, and
  symptom 2 is gone.

The subscription is installed in `sync.ts` rather than inside `namespaceStore`, to
keep the same rule as `pruneResults`: **every wire that subscribes to the
workspace mirror is gathered in `startRenderer()`**, with module load defining
only and wiring nothing, so StrictMode does not subscribe twice.

### 2.4 `TreeView` renders `waiting`

`waiting` takes the same dim notice row as `loading` and no longer takes
`tree.loadFailed`'s error branch. The copy has two forms depending on the
connection's **current** state, because "why was nothing requested" determines
whether the user needs to do anything:

- `connecting` → `tree.connecting` ("Connecting…"): it will fix itself, and the
  user need do nothing;
- otherwise (`error` / `idle` / closed) → `tree.notReady` ("Connection not
  ready"): it will not fix itself. The reason for the failure is the sidebar
  row's job to state, and the tree does not repeat it.

(Hard-coding "Connecting…" here would produce a falsehood when the object tree is
opened after a **failed** connection.)

## 3. Trade-offs

**Why not "add `conn.status` to `TreeView`'s `useEffect` dependencies".** The
smallest change, and it would fix symptom 1. But it ties the rule "when may data
be fetched" to a component mounting: collapsed levels, and any future non-React
call site, are unprotected, and symptoms 2 and 3 are not fixed at all. The root
cause is that the cache does not know about connections, and fixing it in the
component goes around the root cause.

**Why not "recognise `notReady` in `loadChildren`'s catch and not cache an
error".** That merely stops showing the error; the tree is still empty and still
waits for someone to click refresh. It treats the symptom, and matching main's
error code as a string in the renderer is a new implicit coupling.

**Why not defer opening the tree view until `ready`.** That gives "click connect"
a window with no feedback at all, and makes `conn.open`'s `treeViewId` return
value asynchronous — it is currently a synchronous product of the reduce, and
MCP's `connect` tool depends on that. The cost far exceeds the benefit.

**Why the cache is not cleared when a connection turns `error` (drops).** Once
cleared, `useNodes` returns `null`, `TreeLevel` returns `null` outright, and the
tree becomes a blank — while the `useEffect` does not re-run, so what the user
sees is "the tree vanished", which is more baffling than an unusable old tree.
The drop itself is already stated plainly on the sidebar's connection row; with
the old tree left in place, any operation immediately reports the real error. On a
successful reconnection §2.3's ready branch refetches it wholesale.

**Why `ready → ready` does not refetch.** No transition, no event. Only entering
`ready` means "the data source became usable once".

## 4. Verification

### Automatic

A new `renderer/state/__tests__/namespace-cache.test.ts` drives the store directly
under node:test (zustand needs no DOM, and the bridge is only accessed on
`window` inside function bodies, so a stub suffices):

1. with the connection `connecting`, `loadChildren` does not call the bridge and
   writes `waiting`;
2. once the same key turns `ready`, the subscription replays it, and it lands
   `ready` with nodes;
3. a connection absent from the workspace likewise writes `waiting` and does not
   call the bridge;
4. a genuine introspect failure still lands `error` (the gate has not swallowed
   real errors too);
5. `ready → error → ready` refetches (a reconnection leaves no stale data);
6. once a connection leaves the workspace its cache is cleared, and other
   connections are unaffected.

### By hand

1. Start the app and click any disconnected entry in the sidebar → the object tree
   panel appears showing "Connecting…" first, and the root level appears by itself
   once the handshake completes. **No "failed to load" at any point, and no
   refresh needed.**
2. Once through for each driver (postgres / mysql / redis / qdrant / sqlite).
3. Expand two levels and click "Refresh"; behaviour unchanged (the manual refresh
   path was not touched).
4. Expand several levels, close the connection, then create a new connection to
   the same target → the new tree loads from the root level.

## 5. Effect on PLAN

The introspect row in PLAN §8's performance budget table:

> tree lazy loads + caches + invalidated by manual refresh

becomes:

> tree lazy loads + caches + invalidated by connection state transitions +
> invalidated by manual refresh

The manual refresh path is preserved exactly; this **adds** an invalidation
trigger rather than replacing it.
