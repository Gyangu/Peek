# A real stub for `ConnectionManager`'s two electron dependencies

> 2026-08-02. Closing out the technical-debt ledger entry (`PLAN.md` §11.2) that
> reads "`ConnectionManager` can only be unit tested through a stub": "the real
> end state is an electron stub for those two modules".

---

## 1. What this fixes

### 1.1 The stub is JavaScript written inside a string

To let the real `manager.ts` load under `node:test`,
`bus/__tests__/deadline-escalation.test.ts` uses `registerHooks({ load })` to
swap `connections/host-process` and `connections/port-broker` for two **inline
JS source strings**:

```ts
const HOST_STUB = `
export class DriverHostProcess {
  async call(method, params) {
    if (method === 'connect') return { capabilities: [...], serverInfo: { version: 'stub' } }
    …
  }
}
`
```

It runs, and what it runs is the **real** `ConnectionManager` — that part is
right and should not change. The problem is the stub itself:

1. **It is not type checked.** JavaScript inside a string is text as far as
   `tsc` is concerned.
2. **`call()`'s return value is unconstrained.** `HostRpcMap` specifies the
   result shape for every method, and the stub may return anything. If
   `HostResult<'connect'>` gains a required field later, the stub keeps returning
   the old shape, `manager.ts` reads `undefined`, and **the test stays green**.
3. **Configuration can only travel by global.** The stub cannot import anything,
   so "which capabilities does this connection declare" is passed in through
   `globalThis.__peekStubCaps`.

The second point is not hypothetical. `PLAN.md` §9.1 records that this
repository has already been bitten by the same species once:

> The stub replayed agent messages only, so it was perfectly self-consistent with
> a translator that discarded every `user_message_chunk`. It took running a real
> agent to see that the restored conversation was a Claude monologue.

**The stub and the code under test corroborate each other and are wrong
together** — and a stub that is not type checked is that risk with the volume
turned up.

### 1.2 Boundary (explicitly not done)

- **`manager.ts` does not change.** Today it depends on `DriverHostProcess`
  concretely rather than through an interface. That could indeed be better, but
  it is refactoring production code to buy testability, which is not what this
  debt entry asks for (§3).
- **No new behavioural assertions.** The two existing suites keep their meaning
  exactly — they pin a real regression, and their comments say "measured against
  the pre-fix wiring on this exact harness", which stops being true the moment
  the assertions change.
- **No general electron stub.** What is wanted here is a stand-in for those two
  modules, not a simulation of `utilityProcess`.

---

## 2. The plan

### 2.1 The stubs become real TypeScript modules, and the hook redirects instead of injecting

```
apps/desktop/src/main/connections/__tests__/
  stub-host-process.ts    a stand-in for DriverHostProcess
  stub-port-broker.ts     a stand-in for DataPlaneLink
  install-stubs.ts        a resolve hook pointing both specifiers at the files above
```

`load` returning a source string becomes `resolve` returning the stand-in file's
URL. The difference is that the stand-in is now an ordinary `.ts` file in the
repository, covered by `pnpm typecheck`.

Because the test and `manager.ts` resolve to **the same module instance**, the
test can import the stand-in directly to read its bookkeeping, and the
`globalThis.__peekStubCaps` back-channel can go.

### 2.2 Consistency in both directions: naming what manager actually uses

Counted across the repository, `manager.ts` uses 7 + 3 members of these two
classes:

| | members |
|---|---|
| `DriverHostProcess` | `alive` `pid` `spawn` `call` `forceKill` `waitExit` `shutdown` |
| `DataPlaneLink` | `open` `deliver` `close` |

The stand-in file declares that surface, and **both sides are asserted against
it**:

```ts
interface HostSurface { … call<M extends HostMethod>(m: M, p: HostParams<M>, ms?: number): Promise<HostResult<M>> … }

class StubDriverHostProcess implements HostSurface {}          // the stub satisfies it
const _realConforms: HostSurface = null as unknown as RealHost // so does the real class
```

The second line is the important one. The real class has `private` fields, so
the reverse assertion `typeof Real = Stub` is **not** possible (TypeScript's
`private` makes class-to-class assignment fail); but assigning the real class to
an **interface** listing only public members does work. So:

- the real class changes any of those 7 signatures → `_realConforms` fails to
  compile;
- `call()` returns a shape `HostRpcMap` does not recognise → the stub itself
  fails to compile (§1.1 point 2);
- `manager.ts` starts using an eighth member → the stub does not have it and
  fails at run time with "not a function". That one is still a run-time failure,
  but it is a **loud** one, and acceptable; the failure that would have been
  silent is blocked by the first two.

### 2.3 Files involved

```
apps/desktop/src/main/connections/__tests__/stub-host-process.ts   new
apps/desktop/src/main/connections/__tests__/stub-port-broker.ts    new
apps/desktop/src/main/connections/__tests__/install-stubs.ts       new
apps/desktop/src/main/bus/__tests__/deadline-escalation.test.ts    wiring changes, assertions do not
```

---

## 3. Trade-offs

**Why not make `manager.ts` depend on an interface rather than a concrete class**
(lift §2.2's `HostSurface` into production code, have `ConnectionManager` hold
the interface, and inject the stand-in from the test) — that is the cleaner
design, and a seam of seven members is not large. Two reasons not to. First, this
debt entry asks "can it be tested", and it already can; the interface buys
"tested more elegantly". Second, it would turn a pure test change into a
dependency inversion in production code, which deserves its own discussion rather
than a ride on the debt-clearing cart. §2.2's two-way assertion captures 80% of
what the interface would buy — signature drift surfacing at compile time — at a
cost of zero lines of production code.

**Why not `mock.module()`** (built into node:test) — it requires
`--experimental-test-module-mocks`, and every package in this repository has a
test script that is a plain `node --test` with no experimental flags. Adding an
experimental flag to a whole package for one test file is not a fair trade.

**Why the stand-ins live in `connections/__tests__/` rather than
`bus/__tests__/`** — they stand in for modules under `connections/`, and the
second test to use them will most likely live there too. The only current
consumer is in `bus/__tests__/` because the subject under test is deadline
wiring, not because the stand-ins belong there.

---

## 4. Verification

```bash
pnpm --filter @peek/desktop test    # deadline-escalation's assertions, unchanged one by one
pnpm typecheck                      # the stand-ins are now in scope
```

Whether the change is equivalent is judged by **this file's case count and
assertions being entirely unchanged**, with only the wiring different. Then break
it once deliberately, to confirm the new protection is real: add a required field
to `HostResult<'connect'>` temporarily, and `pnpm typecheck` must go red on the
stand-in file — before this change it was green.
