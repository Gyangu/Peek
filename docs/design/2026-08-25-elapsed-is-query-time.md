# The elapsed time a result reports is the query's, not the reader's

## 1. What this fixes

### 1.1 The number on screen answers a question nobody asked

A one-million-row result in peek reports `1,000,000 rows · Done · 40.81 s`. The
same result set, measured by `bench-scroll.mjs` with the viewport driven to the
end, takes **2124ms**. Both numbers are honest and they differ by a factor of
nineteen, because they measure different things: the second is the query, and
the first is the query plus however long the stream sat parked waiting for a
human to scroll.

`elapsedMs` is produced by the cursor as `Date.now() - this.startedAt`, from the
cursor's construction to the frame carrying `done` — identically in all five
implementations:

| Cursor | Line |
| --- | --- |
| `SqlCursor` | `packages/db-sql/src/cursor.ts:222` |
| `PgCursor` | `packages/db-postgres/src/cursor.ts:376` |
| `RedisScanCursor` | `packages/db-redis/src/scan.ts:419` |
| `QdrantPointCursor` | `packages/db-qdrant/src/scroll.ts:214` |
| `Neo4jCursor` | `packages/db-neo4j/src/session.ts:829` |

The backpressure pause is *outside* `cursor.next()` — it happens in the pump, in
`waitWindow()`, between two calls the cursor makes no observation of. So a
cursor's wall clock keeps running through every pause, and the number it hands
out is "how long this result set took from start to finish", where the finish is
set by the reader's scrolling.

That reading is not useless, but it is not the one a duration next to a row count
is taken for. Every database client that prints a time next to a result — psql's
`Time:`, DataGrip, the mysql CLI — prints the query's cost. peek prints something
that is mostly a measurement of the person looking at it, in the same position,
in the same font, with no marking.

### 1.2 It is worse in the one place it is most visible

The README's million-row screenshot is that number, at that size, under a picture
whose whole point is that peek handles a million rows well. A reader who takes
`40.81 s` for what it looks like concludes the opposite of what the shot was taken
to show. The README explains the discrepancy two screens further down, in the
third of three footnotes under the benchmark table; the screenshot does not carry
the footnote with it.

### 1.3 Boundary

- **The field changes meaning; no field is added.** `elapsedMs` becomes the
  query's own time everywhere it already appears. The total wall clock is not
  preserved under a second name — see §3.1.
- **Not merging the two pumps.** `@peek/db-postgres` keeps its own copy of
  `StreamPump` (`host-runtime.ts`), as `driver-host.ts` says it does, pinned by
  that package's tests. Both copies get this change. Collapsing them into one is
  a separate change and does not get to ride along inside this one.
- **Not changing what the cursors measure.** All five keep reporting their own
  wall clock. The subtraction happens in the pump; §2.2 says why.
- **Not touching the chunk sizing, the ack window, or the pause timeout.** The
  backpressure behaviour is unchanged. Only its accounting changes.

## 2. The approach

### 2.1 The pump already knows exactly how long it was parked

`StreamPump` has two places where it waits, and both are waits on the reader
rather than on the database:

- `await Promise.race([this.host.waitPort(), this.stopSignal])` — the data-plane
  MessagePort has not been handed over yet, so there is nowhere to put a frame;
- `await this.waitWindow()` — `ACK_WINDOW` frames are unacknowledged, so the
  renderer has not consumed what it already has.

Neither is the query doing work. The pump accumulates the time it spends in them:

```ts
/**
 * Wall time spent parked — waiting for the data port, or for an ack. This is the
 * reader's pace, not the query's, and it is subtracted out before any elapsed
 * time reaches a reader.
 */
private stalledMs = 0

private async stall<T>(work: Promise<T>): Promise<T> {
  const parked = Date.now()
  try {
    return await work
  } finally {
    this.stalledMs += Date.now() - parked
  }
}

/** A cursor's wall clock, less everything spent parked. Never negative. */
private queryMs(wallMs: number): number {
  return Math.max(0, wallMs - this.stalledMs)
}
```

Both waits are wrapped in `stall()`. The fast path in `waitWindow()` (`unacked <
ACK_WINDOW`, the common case) resolves already-resolved and adds 0.

`queryMs` clamps at zero. The cursor's clock and the pump's clock are two
independent `Date.now()` readings taken from different starting points — the
cursor is constructed before the pump — and while the parked intervals are always
inside the cursor's lifetime, nothing structural stops a clock adjustment from
making the arithmetic go negative once. A negative duration is never the right
thing to show anybody.

### 2.2 The subtraction belongs to the pump, not the cursors

The alternative was for each cursor to accumulate the time it actually spends
inside `next()`, which measures nearly the same thing and reports it at the
source. It is the wrong place for one reason that outranks the others:

**driver packages are third-party code.** They load from `~/.peek/packages/<id>/`
rather than being compiled in — that is the whole point of M8 — so requiring each
cursor to correctly accumulate its own work time makes a credibility figure the
responsibility of the party whose credibility it describes. A driver that gets it
wrong, in either direction, is indistinguishable from one that gets it right.
There is nothing to check it against.

The pump is first-party, in `@peek/core`, and it derives the correction from its
own bookkeeping. It also happens to be one place instead of five, and it covers
drivers peek has never seen.

### 2.3 Both planes have to carry the same number

`elapsedMs` reaches a reader by two independent routes, and until now they were
the same value only because nobody had touched either:

- **the control plane** — the pump emits `result.done` → `ConnectionManager`
  (`manager.ts:685`) → `finishResult` (`mutations.ts:225`) → the workspace, which
  is what the status bar, `QueryView`, `VectorView` and the MCP receipts read;
- **the data plane** — `port.postMessage({ t: 'chunk', frame })`, straight to the
  renderer's result cache. `DataGrid.tsx:1235` reads `liveSnap.done?.elapsedMs`
  from *this* one.

The 40.81 s in the screenshot is the data-plane copy. Correcting only the emitted
event would leave the grid showing the old number and the status bar showing the
new one, which is a worse failure than the one being fixed. So the pump rewrites
the frame **before** `postMessage`, and emits from the rewritten copy:

```ts
const outgoing: ChunkFrame = frame.done
  ? { ...frame, done: { ...frame.done, elapsedMs: this.queryMs(frame.done.elapsedMs) } }
  : frame
port.postMessage({ t: 'chunk', frame: outgoing })
```

A copy rather than a mutation of `frame.done`: the frame came from a driver
package, and reaching into an object a package owns to overwrite a field it just
set is how the pump would come to depend on that package's internals.

`announcePause()` gets the same treatment — `elapsedMs: this.queryMs(Date.now() -
this.startedAt)`.

### 2.4 A pause now reports a small number, on purpose

A pause fires *because* `idleAckMs` (60s by default) elapsed with no ack, so that
entire timeout is inside `stalledMs`. `ResultPause.elapsedMs` therefore drops from
"about sixty seconds" to the fraction of a second the driver spent actually
producing the ~200,000 rows it delivered first.

This is the correct reading of the field under the new definition, and it is also
the more useful one: the sixty seconds was a constant, known in advance, and it
never told anybody anything. What a reader (or an MCP client deciding whether to
re-run) wants from a paused result is `rows` and the reason — both of which are
already there, and neither of which changes.

## 3. Trade-offs

### 3.1 The total wall clock is dropped, not renamed

The obvious alternative is to keep both: `elapsedMs` for the query, a new
`wallMs` beside it for the total. It was considered and rejected.

What `wallMs` would answer is "how long was this result set open", and the honest
version of that question is asked by almost nobody. Meanwhile the cost is
permanent: a second duration in the protocol, in the workspace, in the MCP
receipts, and five display sites (`StatusBar`, `QueryView`, `VectorView`,
`DataGrid`, the log panel) each of which then has to have an opinion about which
one it shows — which is exactly the ambiguity this change exists to remove. Two
durations next to a row count, differing by a factor of nineteen, is not an
improvement on one that is quietly the wrong one.

The information is not entirely gone, either: a result that paused says so, and
`bench-scroll.mjs` times the stream from outside and reports its own `queryMs`,
which is unaffected by any of this.

### 3.2 The number is no longer a wall clock, and cannot be checked against one

After this change, `elapsedMs` is a derived figure — you cannot verify it by
timing peek from the outside with a stopwatch, the way you could before. That is
a real loss of a property, and it is the price of the field meaning the thing it
is read as meaning. The derivation is four lines in one class, tested directly
(§4), and the outside-the-app measurement continues to exist in the benchmark
script, which is where a number that needs to survive scrutiny should live
anyway.

### 3.3 Two pumps, one change, applied twice

Making the same edit in `core/driver-host.ts` and `db-postgres/host-runtime.ts`
is duplicated work that can drift. It is still better than merging the two pumps
inside this change: that merge would put fifty tests and the backpressure state
machine in the blast radius of what is otherwise a four-line arithmetic fix. The
duplication is pre-existing, documented in `driver-host.ts`, and is not made
worse by one more edit that lands in both.

## 4. Verification

1. **A unit test on the accounting, in both pumps.** Drive a pump with a fixture
   cursor and a renderer that withholds acks: park the stream for a known
   interval, then ack. The reported `elapsedMs` must be the cursor's wall clock
   minus that interval, not the wall clock. Without the fix the test reads the
   parked interval back in the result.
2. **Both planes agree.** In the same test, the `result.done` event's `elapsedMs`
   and the `done` on the frame delivered over the port must be equal. This is the
   §2.3 failure, and it is invisible to any test that checks only one route.
3. **The clamp holds.** `queryMs` with `stalledMs` greater than the wall clock
   returns 0, never a negative. `db-postgres/src/__tests__/host.test.ts:399`
   already asserts `paused.elapsedMs >= 0` and must keep passing.
4. **End to end, against the fixture.** The app's own reported `elapsedMs` and a
   figure timed from outside it should now land in the same neighbourhood, where
   before they differed by however long the reader took to scroll.
   `bench-scroll.mjs` is the natural instrument, but its scroll pass needs the
   window in the foreground — an occluded window stops `requestAnimationFrame`,
   and the script says so and stops. `screenshot.mjs` drains the same
   million-row fixture without needing rAF, and the number it captures is the
   one the app reports, so §5 uses that.
5. **The screenshot is retaken.** `node apps/desktop/scripts/screenshot.mjs --only
   million-rows` re-shoots light and dark, and the alt text in both READMEs is
   updated to match.
6. **`pnpm test` and `pnpm typecheck`** across the workspace.

## 5. What it measured

The retake is the check that matters, because it is the same fixture, the same
script, and the same scroll as the shot this change exists to correct:

| | before | after |
| --- | --- | --- |
| `million-rows-light.png` | `40.81 s` | **`2.43 s`** |
| `million-rows-dark.png` | `41.04 s` | **`2.16 s`** |

Against `bench-scroll.mjs`'s independently-timed **2124ms** for the same million
rows — measured from outside the app, on the same machine, and untouched by any
of this — those land where they should. The nineteen-fold gap is gone, and what
is left is the spread you would expect between two runs of the same query.

That 2124ms is the previously-recorded figure rather than a fresh one:
`bench-scroll.mjs` was run and stopped in its scroll pass with `requestAnimationFrame
did not fire in 5000ms; document.visibilityState is "hidden"`, which is the
script refusing to report frame numbers it cannot measure. Re-running it with the
window in front would confirm the frame figures too; the elapsed-time claim above
does not depend on it.

`pnpm test` passes for six of seven packages; `@peek/db-sql`'s MySQL suites fail
identically before and after this change, for want of a MySQL server on the
machine, which is pre-existing and unrelated.

One thing the retake does not fix, and did not set out to: the alt text still
transcribes a per-run duration, and the two images now read `2.43 s` and
`2.16 s`, so the `about 2.4 s` in the alt matches the light one it hangs on and
approximates the dark one. That is the same structural complaint
`2026-08-24-three-claims-nothing-checks.md` §1.4 recorded and declined to fix, and
it is declined here too — for the same reason, which is that it is about how alt
text is written for a `<picture>`, not about what the number says.
