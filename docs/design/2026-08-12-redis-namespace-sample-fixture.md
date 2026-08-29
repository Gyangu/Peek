# db-redis's standing red: the fixture ran into the namespace tree's sampling ceiling

> 2026-08-12. Picks up the **first** of the two questions left open by
> [`2026-08-07-database-packages-from-disk.md`](2026-08-07-database-packages-from-disk.md)
> §4vicies(e). The second — silent absence on truncation — is not decided here;
> it is restated verbatim in §4 and awaits alignment.

## 1. What this fixes

`builds a namespace tree from key prefixes, lazily` in
`packages/db-redis/src/__tests__/redis.test.ts` has been red for a long time. The
assertion is `assert.equal(tags?.kind, 'key')` and the actual value is
`undefined`. Run against a live redis (local 8.x, a clean instance with
`dbsize 0`) eight times this round, it was red all eight — this is not
intermittent.

The cause: `sampleLevel` in `keyspace.ts` scans at most
`PREFIX_SAMPLE_KEYS = 2_000` keys per level, and this fixture puts
`BULK_KEYS = 3_000` `peek:test:bulk:*` keys under `peek:test:` at **that same
level**. SCAN stops at the ceiling, and `peek:test:tags`, which sorts behind
them, is never reached. Which key falls off is decided by redis's bucket order
rather than by insertion order — so truncation is certain, and who gets truncated
is not.

**Boundary**: this changes the test fixture only. `keyspace.ts` is untouched, the
sampling ceiling itself is untouched, and how truncation is presented is
untouched.

## 2. The plan

Two changes in `packages/db-redis/src/__tests__/redis.test.ts`:

1. `BULK_KEYS` 3_000 → **1_500**. That leaves 1,510 keys under `peek:test:`, so
   `sampleLevel`'s SCAN runs all the way to `cursor === '0'` with
   `partial === false`, and not one leaf key at that level goes missing. The
   figure 1,500 is bracketed from both sides: the pagination test needs
   `pages > 1` at `limit = 400` (so it must be well above 400), and at
   `SCAN_COUNT_HINT = 500`, 1,500 keys is still three or four round trips, which
   preserves what the fixture's comment was after — "make the scan take several
   round trips, so a cancellation has time to land".
2. A new guard, `keeps its own fixture inside one namespace-tree sample`: count
   the real number of `peek:test:*` keys at run time and assert both
   `>= BULK_KEYS` (the fixture really was built) and `< PREFIX_SAMPLE_KEYS` (it
   has not crossed the ceiling). The test imports `PREFIX_SAMPLE_KEYS` directly,
   so if the ceiling ever moves the guard moves with it rather than the two
   disagreeing.

The guard **counts** rather than computing from the constant: anyone who adds
keys to the fixture later is counted in too.

**No existing assertion is relaxed**: `seen.size === BULK_KEYS`,
`seen.length === BULK_KEYS`, `rows.length === 400` and `pages > 1` all stay
exactly as they were. They simply run against 1,500 keys.

## 3. Trade-offs

- **Change the assertion (assert that dropping keys is expected) — does not
  hold.** At 3,000 keys, whether `user` or `tags` falls off is bucket order, so
  an assertion in either direction is uncertain, and writing one just creates a
  new intermittent red. Besides, the fixture's comment says those 3,000 keys
  exist for "several round trips plus a cancellation landing"; nothing in this
  suite tests the behaviour of the sampling ceiling, so there is no semantics
  here to preserve.
- **Change the implementation (raise or remove the ceiling) — not this round.**
  The ceiling is a trade-off written into `keyspace.ts`'s header comment and into
  the design: the tree is a direction, the scan is the truth, and on a keyspace
  nobody dares walk in full, being bounded is the precondition. Changing product
  behaviour for the sake of one test is backwards.
- **Move the bulk keys to a sibling prefix outside `peek:test:` and keep 3,000 —
  costs more.** The type filter and the `contains` filter tests on
  `pattern('peek:test:*')` would fall from 3,010 keys to 10, which zeroes out
  their volume; `purge` would need changing, and so would the isolation
  convention that every key this suite creates lives under PREFIX. All that buys
  is twice the volume in the pagination test. Not worth it.

## 4. Still undecided: the driver is silent when it hits the ceiling

> **Settled 2026-08-12** — the change and its verification are in
> [`2026-08-12-redis-truncated-namespace-level.md`](2026-08-12-redis-truncated-namespace-level.md):
> `NamespaceNode` gained an `elision`, `sampleLevel` adds a `#truncated` node on
> truncation, and the wording is localised by the window rather than hard-coded
> in English by the driver. This section is kept as written; it is that
> document's starting point.

The second question in §4vicies(e) is **not touched here**, and is restated so it
does not get lost:

When `sampleLevel` truncates, prefixes it **has seen** carry
`~n keys (sampled)`, while keys it has **not** seen simply do not appear. The
two collapse nodes, `#more-prefixes` and `#more-keys`, are decided by
`heads.length > MAX_PREFIX_NODES`, not by `sample.partial`. So if the tail cut
off a level happens to be all leaf keys, that level looks complete and the user
gets no hint whatsoever. Any real database with more than 2,000 keys under one
level hits this — the same thing this document's test ran into, except that the
test can go red at us and the user cannot.

The fix (add a collapse node when `partial`, or let `detail` say something)
changes product behaviour in `keyspace.ts`, so per CLAUDE.md the document comes
before the code, and this awaits alignment.

## 5. Verification

- `pnpm --filter @peek/db-redis test`: **38 pass / 0 fail** (36 pass / 1 fail
  before), green across eight consecutive runs.
- **Inverse check on the new guard**: temporarily put `BULK_KEYS` back to
  `3_000` → the guard goes red with
  `3010 keys under peek:test: exceeds the 2000-key sample ceiling: the tree can no
  longer see every key at that level. Lower BULK_KEYS.`, and the tree case goes
  red alongside it; back to `1_500` → all green.
- `pnpm --filter @peek/db-redis typecheck` green.

### A separate intermittent red, unrelated to this document

`pages a large keyspace through nextCursor` (`limit: 400`) went red **once** in
the nine baseline reruns before this change, with `2999 !== 3000` — one key
under-delivered. It has not recurred across eight runs since the fixture change,
but halving the key count only lowers the probability; **it is not fixed**.
Pagination resume uses a two-part `<boundary>:<skip>` token, and if the dict
completes a rehash between two SCANs the buckets one cursor covers change, so
skipping `skip` rows may skip keys that were never emitted — whereas the comment
in `scan.ts` promises "resends at worst, never drops". **This needs its own
investigation**, and should not be treated as gone just because this document is
green.
