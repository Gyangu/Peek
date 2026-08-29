# When a level cannot be scanned to the end, the tree has to say so

> 2026-08-12. Settling what
> [`2026-08-12-redis-namespace-sample-fixture.md`](2026-08-12-redis-namespace-sample-fixture.md)
> §4 left hanging: **the driver is silent when it hits the sampling ceiling**. That
> document touched only the test fixture and explicitly left `keyspace.ts`'s product
> behaviour alone; this one changes exactly that.

## 1. What this fixes

### Where things stand

`sampleLevel` in `packages/db-redis/src/keyspace.ts` scans at most
`PREFIX_SAMPLE_KEYS = 2_000` keys per level:

```ts
} while (cursor !== '0' && scanned < PREFIX_SAMPLE_KEYS)
return { groups, leaves, partial: cursor !== '0' }
```

That `partial` fact is **only half used by the time it reaches `levelNodes`**. It
is fed to `formatKeyCount`, so prefixes already seen display as
`~n keys (sampled)` — which is honest. But it takes no part in deciding **whether
this level should carry another node**:

```ts
if (heads.length > shownHeads.length)      // #more-prefixes
if (sample.leaves.length > leafKeys.length) // #more-keys
```

Both collapse nodes are decided by `MAX_PREFIX_NODES = 200`, a **presentation**
ceiling, which has nothing to do with `sample.partial`, a **reading** ceiling.

So there is a whole class of real situation in which the interface simply lies: a
level with 50,000 keys beneath it, all of them leaf keys (no deeper `:` segments),
with no more than 200 prefix groups. SCAN stops at 2,000, neither `groups` nor
`leaves` reaches 200, neither `if` holds, and the level is drawn with **every node
looking complete while 48,000 keys are absent from the tree with not one line
saying they exist**.

Any real database with more than 2,000 keys under one level hits this. The
long-standing red test in the previous document ran into the same thing; the
difference is only that a test can go red at us and a user cannot.

### The part that is not a defect

The ceiling of 2,000 itself **does not change**. `keyspace.ts`'s header comment
argued it: redis has no schema, the only structure is prefix convention, and the
only means of discovery is looking at keys; on a keyspace nobody dares walk in
full, **the tree is navigation and the scan is the truth**. Being bounded is the
precondition for this tree existing at all.

`MAX_PREFIX_NODES = 200` does not change either, and neither do
`#more-prefixes` / `#more-keys`'s semantics — they say "I saw them and did not
draw them", which is a different thing.

### Boundary

- Only the "this level was not read to the end" signal is added; no pagination, no
  resumed scanning, no "load more". The route to seeing everything already exists:
  open this level as a table, which is a genuine full cursor scan.
- Nothing is added for postgres / qdrant / neo4j. Their `listChildren` returns the
  whole level today, with no truncation to speak of.
- The output structure of the MCP `introspect` tool does not change (it already
  reads `detail`; see §2.4).

## 2. The plan

### 2.1 The kernel: a place on `NamespaceNode` for "elided"

`packages/core/src/capability.ts`:

```ts
export interface NamespaceElision {
  /**
   * How many children were folded away, when the driver counted them all.
   * Absent means it could not: the listing stopped before the level did, and
   * there is no honest number to put here.
   */
  remaining?: number
}

export interface NamespaceNode {
  // …
  /**
   * Set on a node that stands for children this level left out, rather than for
   * anything in the store.
   */
  elision?: NamespaceElision
}
```

**Why `remaining` is an optional number rather than a
`'counted' | 'unknown'` enumeration**: so that "there is no honest number" is an
**absence in the type**. An enumeration relies on two fields staying consistent
with each other, and admits self-contradictory values like
`{ kind: 'unknown', remaining: 40 }`; an optional number does not — no number is no
number, and a UI that cannot get one cannot say "N more". That constraint is what
this document exists to hold, and a type holds it more reliably than a discipline
about wording.

### 2.2 The driver: `keyspace.ts` passes `partial` outwards

Three changes, all in `levelNodes` / `foldedNode`:

1. `foldedNode` is renamed `elidedNode` and takes a `NamespaceElision`.
2. `#more-prefixes`: **drop the number when `partial`**.
   `heads.length - shownHeads.length` is exact for the **sample** and not for the
   **level** — SCAN stopped partway, and how many new prefixes are in the part it
   never read is unknowable. Keeping that number wraps an inexact fact in an exact
   figure. So when `partial`, `remaining` is absent and `detail` goes from
   `"40 more prefixes"` to `"more prefixes"`.
   `#more-keys` never had a number to begin with (`sampleLevel` stops collecting
   leaves at `MAX_PREFIX_NODES`, so even the remainder within the sample cannot be
   counted), and stays as it is.
3. **New**: when `sample.partial` is true, append a `#truncated` node at the end of
   the level with `elision: {}` (count unknown), whose `detail` explains that the
   scan stopped early and that seeing everything means opening this level as a
   table.

In the extreme a level can carry three `…` rows at once (`#more-prefixes` +
`#more-keys` + `#truncated`). All three say different things and all three are
true: "seen but not drawn", "so many leaves they were not collected", "never read
at all". Merging them would dilute the most important one — that keys were
**never read** — into "there is more anyway", so they are not merged. Triggering it
requires one level to have both more than 200 head segments and more than 2,000
keys, and that cost is acceptable.

### 2.3 The interface: the wording belongs to the UI, translated once

When `apps/desktop/src/renderer/components/views/TreeView.tsx` renders a node, the
presence of `node.elision` replaces `name` and `detail` (and the `title` tooltip)
with localised copy. The pure function `elisionLabel(elision, t)` is extracted into
`treeElision.ts` so it can be tested under node:test without a DOM — the same
approach as `browseControls.ts` and `openTarget.ts`.

Two keys, written in both en and zh-CN:

| key | en | zh-CN |
| --- | --- | --- |
| `tree.elision.more` | `{count} more, not shown` (one/other) | `还有 {count} 项未显示` |
| `tree.elision.unknown` | `More here than this tree read — open this level as a table to see everything` | `这一层没有读完，还有内容没显示 —— 把这一层当表格打开才能看全` |

`tree.elision.unknown` carries **no number at all**, deliberately. The wording also
avoids formulations like "only the first N are listed": when N is itself an
estimate, an exact figure only persuades the reader that the rest does not matter.

### 2.4 MCP needs no change

`briefNode` in `apps/desktop/src/main/mcp/tools/introspect.ts` already carries
`detail` into the outline and the JSON. The driver-side `detail` stays English (the
comment in `keyspace.ts` reading "English on purpose: MCP reads `detail` too" still
holds), so a model still reads "the scan stopped early". The UI goes through
`elision` and is localised, MCP goes through `detail` and is English, and both
paths are complete without either accommodating the other.

## 3. Trade-offs

### 3.1 Should this signal be redis's alone, or part of the kernel contract?

**This is the one question this document has to answer head on**, because
`NamespaceNode` is the contract between every driver and the UI, and the cost of
adding a field to it is not borne by redis alone.

**Option A: redis's alone.** Leave `NamespaceNode` untouched, and have
`keyspace.ts` emit a collapse node with an English `detail`, exactly like
`#more-prefixes`.

- Cost 1 (paid immediately): `TreeView` renders `detail` **verbatim**. A Chinese
  user would see an English sentence on the one row saying "this tree is lying to
  you". That sentence's entire purpose is to interrupt trust, and it has to be in
  the reader's language or it cannot even be understood.
- Cost 2 (paid later): the wording scatters across every driver. Only redis is
  bounded today, but **"this level was not read to the end" is not a redis fault,
  it is a shape problem in `listChildren`** — any driver that has to page a catalog
  hits it (a mongo with 100,000 collections, an object store listed by prefix, a
  neo4j label scan that has to walk the whole graph). With each writing its own
  English, users see three phrasings for one thing.
- Cost 3: the UI cannot distinguish "a placeholder node" from "a folder in the
  store genuinely called `…`". That is already the case (`foldedNode` is a fake
  `kind: 'folder'`), and choosing A cements the compromise.
- Benefit: zero kernel change, zero cross-package coupling, the smallest change
  surface.

**Option B: the kernel contract.** `NamespaceNode.elision`; see §2.1.

- Cost 1: `NamespaceNode` crosses IPC and package boundaries, and one more optional
  field is one more thing every driver author may forget to set. **This change does
  not abolish silence** — the default failure mode is still silence, and it only
  gives a driver that wants to speak a way to.
- Cost 2: the UI now has to handle a node corresponding to nothing in the store.
  The context menu, double-click-to-open and selection all have to be harmless
  against it. Today that holds **by accident** ("no `ref`, so `openSpecForNode`
  returns null"), and choosing B writes that coincidence down as a convention.
- Cost 3: one more concept in the contract to explain and to be understood.

**B is chosen.** Two reasons:

1. The defect being fixed is not fundamentally "redis omitted a sentence", it is
   that **`listChildren`'s return value has no place to express completeness**. An
   interface that can only return `NamespaceNode[]` leaves "is this list all of
   them" entirely outside the type, and redis is merely the first to run into it.
   Fixing the contract is closer to the defect than adding an English sentence
   inside redis.
2. The costs are asymmetric in time: A-1 is **immediate and certain** (the next
   Chinese user runs into it), while B-1 is **potential and no worse than the status
   quo** (which is that every driver is silent; after the field, the worst case is
   still silence). Trading a certain loss for a potential burden is not a good deal.

**What was not taken from B is drawn too**: no wrapper around `listChildren`'s
return value (`{ nodes, complete }` and the like). That would change the IPC shape,
`IntrospectReader`, namespaceStore's cache entries and the MCP tool — four things
in concert — to put the same fact somewhere else. An elision node is already this
tree's existing vocabulary (`#more-prefixes` has used it for a long time), and
reusing it is far cheaper than inventing another layer of structure.

### 3.2 Raise or remove `PREFIX_SAMPLE_KEYS` — not done

The previous document already refused this once, and the reasoning stands: the
ceiling is a design trade-off written into `keyspace.ts`'s header comment, not a
knob that can be loosened. Raising it to 20,000 merely defers the same lie to a
larger database, and pays for it with a SCAN that may take seconds. **The problem
was never "it does not scan enough", it is "it says nothing when it cannot
finish".**

### 3.3 Keep `#more-prefixes`'s number when `partial` — not done

See §2.2 item 2. This is where this document's hard constraint ("do not imply the
count is accurate") lands in the code: better to withhold a number than to state
one that will be believed.

### 3.4 Make the truncation signal a new `NamespaceNodeKind` of `'truncated'` — not done

`NamespaceNodeKind` is **the kind of object in the store** (table / view / key /
column), each with a glyph in `iconOf`. An elision node is not an object in the
store, and putting it into that enumeration blurs what `kind` means and forces a
branch into every driver's `switch (kind)`. With an orthogonal optional field,
`kind` keeps its meaning (`'folder'`, a container) and `elision` explains that this
container stands for things not listed.

## 4. Verification

### 4.1 Automated

**`packages/db-redis/src/__tests__/contract.test.ts` (needs no redis server)**

`RedisKeyspace`'s constructor parameter is `KeyspaceDeps`, so a fake `scanPage` can
be supplied and truncation behaviour tested **deterministically** — compared with
the previous document's "run against a live database and watch bucket order", this
is the real guard here. Three cases added:

1. `a level that scanned to the end says nothing about truncation` — a fake deps
   returning `cursor: '0'` in one page, asserting no node with an `elision` in the
   result and every leaf key node present.
2. `a level cut short at the sample ceiling carries an elision with no count` — a
   fake deps returning a non-zero cursor forever with `SCAN_COUNT_HINT` keys per
   page, asserting:
   - a node exists whose `id` ends in `#truncated`;
   - its `elision` exists with `remaining === undefined`;
   - its `detail` **contains no digit** (`/\d/` does not match) — which pins "do not
     imply the count is accurate" directly, so that however the wording changes it
     cannot put a number back.
3. `folds a counted prefix tail with its count, and an uncounted one without` — one
   in each direction: scanned to the end plus prefix overflow → `remaining` is an
   exact number; not scanned to the end plus prefix overflow → `remaining` absent
   and `detail` with no digit.

**`apps/desktop/src/renderer/components/views/__tests__/tree-elision.test.ts` (new)**

`elisionLabel`'s two branches × two languages, asserting that the unknown branch's
copy contains no digit in either language.

**`apps/desktop/src/renderer/i18n/__tests__/i18n.test.ts` (unchanged)**

The three existing catalogue parity guards cover the new keys automatically: a
missing zh-CN translation, or mismatched plural or placeholder shapes, goes red
directly.

**Not one existing assertion is relaxed.** `redis.test.ts`'s
`builds a namespace tree from key prefixes, lazily` runs against 1,500 keys with
`partial === false`, and this document does not change the branch it takes; the
assertions stay as they are.

### 4.2 Inverse checks (every new guard is broken once)

See the brief, which records how each was broken and what red looked like.

### 4.3 By hand

Connect to a real database (or load 3,000 leaf keys at one level with
`redis-cli`) and expand that level: a `…` row should appear at the end, reading
`这一层没有读完，还有内容没显示 —— 把这一层当表格打开才能看全` in the Chinese
interface and the corresponding English when switched; double-clicking it does
nothing (no `ref`), and its context menu has no "open". Opening that level as a
table, a full cursor scan reaches 3,000 rows.
