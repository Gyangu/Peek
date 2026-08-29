# `KeyValueWindow.shape` is validated, documented, and produced by nobody

> 2026-08-02. The technical-debt ledger entry (`PLAN.md` §11.2) reading
> "`KeyValueWindow` is still a flat bag at the process boundary". Going to clear
> it turned up two things: **the ledger's prescribed fix points at the wrong
> place**, and what is actually broken is something else.

---

## 1. What this fixes

### 1.1 The ledger's prescription is wrong

The ledger says:

> The compromise is "mutually exclusive by type in-process, validated at run time
> at the process boundary" (`core/keyValueReadOptions()`). To unify it,
> `main/driver-rpc.ts` need only call `keyValueReadOptions()`.

Following that would do the thing backwards. `readKeyValueWindow` in
`driver-rpc.ts` produces the **wire form** `KeyValueWindow`, and that type's
flatness is **deliberate** — `capability.ts` says so itself:

> `KeyValueReadOptions` is naturally mutually exclusive because every in-process
> caller writes it as a literal and the compiler can police it. This one arrives
> as JSON from another process, where the compiler polices nothing — so it is a
> bag of optional fields, validated **exactly once** at the boundary by
> `keyValueReadOptions` below.

That validation already happens in the right place: `core/driver-host.ts:593`,
after the driver host receives the RPC. `driver-rpc.ts` runs in main, and its job
is to narrow **untrusted `unknown`** into the wire type, not to narrow the wire
type into the in-process union — the latter needs information only the driver
has.

So the first half of this debt entry resolves to **do nothing**: the current
state is correct and the ledger is wrong.

### 1.2 What is actually broken: `shape` vanishes at both ends

`KeyValueWindow` has five fields, `shape` among them, and the reason it exists is
written in `keyValueReadOptions`'s comment:

> When `shape` is declared, the addressing has to be the kind that shape uses —
> **putting an offset into a hash is not a small forgivable mistake, it is asking
> for a page of rows the server will never return**. A caller that knows the
> shape — and the inspector always does, it is holding the previous
> `KeyValueResult` — should send it, so that the window is validated **against**
> the shape rather than guessed at.

In reality neither end is wired:

| location | behaviour |
| --- | --- |
| `renderer/components/views/keyWindow.ts:46` | `nextKeyWindow` **reads** `result.value.shape` and uses it to pick which field to fill, then **does not send it** |
| `main/driver-rpc.ts:136` | `readKeyValueWindow` reads `limit` / `offset` / `cursorToken` / `match` field by field, **with no `shape`** |

So `keyValueReadOptions`'s `switch (shape)` always takes the `case undefined`
branch and infers backwards from "which field was actually filled". The stronger
validation the comment describes **has never once run in production**.

Concretely: a stream's resume cursor is an entry id (`(1712…-0`), which by the
table in §1.2 goes into `cursorToken`. Without `shape` the inference rule is
"cursor only → `map`", so **the next window of a stream passes validation as a
map**. The data is not wrong — the driver ultimately re-dispatches on the key's
real TYPE, which is the only authority — but the boundary check written
specifically for this class of error is spinning freely.

This is the same species as the `source: 'agent'` fix earlier this round: a
comment describing, in the present tense, a mechanism that was **never wired**.

### 1.3 Boundary (explicitly not done)

- **`KeyValueWindow`'s flat shape does not change.** See §1.1; it is correct.
- **The driver's re-dispatch on real TYPE does not change.** That is the
  authority; `shape` is only a check one step earlier.
- **No keyValue tool is added to MCP.** This only finishes wiring a channel that
  already exists.

---

## 2. The plan

Two lines, one at each end:

```ts
// keyWindow.ts — it has already been computed; carry it
if (field === 'cursorToken') return { limit, shape, cursorToken: cursor }
…
return { limit, shape, offset }

// driver-rpc.ts — recognise the field at the boundary
...(isKeyValueShape(rec['shape']) ? { shape: rec['shape'] } : {}),
```

`shape` is validated against an allowlist rather than `typeof === 'string'`: it
feeds `keyValueReadOptions`'s `switch`, and an unrecognised string would fall
silently into `default`/`case undefined` — which is precisely the path this
change exists to eliminate. So `core` exports an `isKeyValueShape` type guard —
`KeyValueShape`'s member list previously existed only as a type, unavailable to
run-time validation.

Once wired, a window whose addressing does not match its shape is turned away at
the **boundary** with `BAD_REQUEST`, instead of being inferred into a different
shape and caught later by the driver.

Two comments that have become inaccurate are corrected along the way:

- `keyWindow.ts:14` says "`KeyValueReadOptions` is a bag of optional fields" — it
  is now a discriminated union, and the flat one is `KeyValueWindow`;
- `capability.ts`'s "the inspector should send shape" becomes a statement of
  something that now happens.

### 2.1 Files involved

```
packages/core/src/capability.ts                       isKeyValueShape + comments
apps/desktop/src/renderer/components/views/keyWindow.ts   carries shape + comments
apps/desktop/src/main/driver-rpc.ts                   recognises shape at the boundary
```

---

## 3. Trade-offs

**Why not simply delete `shape` from `KeyValueWindow`** — that would also make
the types agree with reality, and more cheaply. It loses the only semantic check
that can be made **across a process boundary**. After deleting it, a request that
puts an offset into a hash could only be discovered when the driver dispatches on
TYPE, and by then the error message is about something else. Wiring up two lines
of an already-written validation is the better bargain.

**Why `shape` stays optional** — the first read of a key genuinely does not know
its shape, and that is already a named member of the `KeyValueReadOptions` union
(`shape?: undefined`). Optional is not a compromise here; it is what the field
means.

**Why add `isKeyValueShape` rather than hand-write an array in
`driver-rpc.ts`** — that would copy `KeyValueShape`'s member list a second time,
and this repository has only just been burned by "a second copy of one contract"
(the zod episode in PLAN §8.2).

---

## 4. Verification

```bash
pnpm --filter @peek/desktop test
pnpm --filter @peek/db-redis test   # keyValueReadOptions's contract tests are here
pnpm typecheck
```

New assertions:

- `nextKeyWindow` returns a window carrying `shape` for all six shapes, and what
  it carries is the result's own shape;
- every one of those windows passes `keyValueReadOptions`, and **the shape that
  comes back equals the shape that went in** — this is the whole point. Before
  the change it fails for **two** of the five pageable shapes: a stream fills
  only the cursor and is inferred as `map`; a sortedSet fills only the offset and
  is inferred as `list`. The other three (map / set / list) happen to coincide
  with the inference rule, which is why the defect is invisible in them — and
  why it survived this long;
- `readKeyValueWindow` recognises a legal shape and discards an illegal string.
