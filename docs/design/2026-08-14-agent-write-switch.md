# Writing data: a person may write at any time, an agent needs a switch

> 2026-08-14. Overturns the premise of PLAN §1's fourth non-goal and of §10's
> "Write operations" section. User decisions, four of them, recorded in §1.2.

## 1. What this fixes

### 1.1 Where things stand: read-only is not "not built yet", it is built

That sentence in PLAN §10 still describes today's code accurately:

> Peek's read-only mode **is not "writes have not been built yet," it is a
> guarantee that has been built**, enforced by the server, and the client does
> not parse a single line of SQL. So the phrase "flip the read-only switch the
> other way" does not even make sense: there is no such switch.

Counted out one driver at a time, here is what it looks like today:

| driver | where read-only comes from | granularity |
|---|---|---|
| PostgreSQL | one `BEGIN READ ONLY` per cursor (`db-postgres/cursor.ts:137`, `:188`, `:203`) | **per query** |
| MySQL | `ROLLBACK; SET SESSION TRANSACTION READ ONLY` on every checkout (`SqlDialect.sessionSetupSql`) | **per checkout** |
| SQLite | **the open flag on the file** (`db-sql/session.ts:159` header comment: the open flag for SQLite) | **the whole connection** |
| Redis / Qdrant | the driver simply never sends a write command — there is no general-purpose statement exit | not applicable |

There is no keyword allowlist of any kind, and that is deliberate: parsing SQL to
decide whether it writes is a game you cannot win.

### 1.2 The user's four decisions

1. **That "Read-only, always." no longer holds.** Peek has to be able to change
   data.
2. **A person (`ui`) may write at any time**, bound by no switch at all.
3. **An agent may write only once the switch is on** (the `mcp` / `agent` pair).
4. **The switch lives on the sidebar's database connection**, flippable in
   passing, so it is convenient to toggle quickly.
5. Changing data is wanted **both through SQL and by editing the grid directly**;
   it may be split into two changes, SQL first.

### 1.3 The boundary this time

**Doing**: the mechanism that routes by source, the sidebar switch, the SQL path
(typing an `UPDATE` in a query view runs), and corrections to four pieces of
outward-facing copy.

**Not doing (left to the second change)**: editing grid cells directly. What that
needs is a different batch — primary-key inference (a result set that came back
from a `SELECT` without its primary key cannot be edited), dirty-value tracking,
commit/rollback UI — and it shares no parts with this document's source routing;
mixing them would leave neither one stated clearly.

**Not doing (untouched here)**: writes for Redis / Qdrant. They have no
general-purpose statement exit, the `tabularQuery` route does not exist on them
at all, and opening writes for them would first require designing *what* is
written (`SET` / `DEL` / upsert point are one command each), which is a document
of its own. **So the sidebar switch does not appear on those two kinds of
connection**, rather than appearing and doing nothing.

## 2. The plan

### 2.1 Two axes, do not conflate them

- **The capability axis**: can this connection write at all — declared by the
  driver package (new capability `write`)
- **The source axis**: who issued this query — `CommandSource`, recorded since M6

The new switch governs **the source axis**, not the capability axis. For a driver
that does not declare `write`, the switch means nothing (§1.3's Redis / Qdrant).

### 2.2 What the switch is

`ConnectionState` gains a field:

```ts
interface ConnectionState {
  // …
  /**
   * On this connection, whether statements issued by the agent are allowed to
   * write.
   *
   * Governs the two sources `mcp` / `agent` only. `ui` may always write (see
   * §2.4), which is why this field is not called `writable` — it does not
   * describe the connection, it describes **the authorisation granted to the
   * agent**.
   */
  agentWrites: boolean   // off by default
}
```

**Off by default, not persisted.** A restart returns it to false, and so does a
reconnect. The reasoning: what the user asked for is "convenient to toggle
quickly", and that is the register of a temporary authorisation; whereas a write
authorisation that lives in `connections.json` and survives restarts most likely
fails by **a person forgetting it is on**. Quick toggling is itself what keeps
"turn it on when you need it" from being a burden.

> This is the one default in this document that I set on the user's behalf. The
> user said nothing either way about persistence; it is recorded here to be
> struck down at review.

### 2.3 Where it lands: `allowWrite` goes on the request, not on the session

`TabularQueryRequest` gains a field:

```ts
interface TabularQueryRequest {
  // …
  /**
   * Whether this one query is allowed to write.
   *
   * The driver **does not know** the concept of an agent; all it receives is a
   * boolean. Who counts as an agent, and whether the switch is on, is the
   * kernel's judgement — reasoning in §2.4.
   */
  allowWrite?: boolean   // defaults to false
}
```

It goes on the **request** rather than the session because a person and an agent
issue statements alternately on the same connection, and PG's read-only
granularity happens to be exactly per query (the first row of §1.1's table) — the
granularities line up, so no connection has to be rebuilt in order to switch.

The computation happens in main, in one place:

```
allowWrite = (envelope.source === 'ui') || connection.agentWrites
```

The `system` source does not write (it only issues internal maintenance
statements).

### 2.4 The decision belongs to main, not to the package — this is the security boundary itself

**What the driver receives is a boolean, not a source.** That line is not
fastidiousness, it is the direct continuation of M8's decision 7:

Drivers run inside packages on disk, possibly written by someone else. If
`source: 'ui' | 'agent'` were passed down for the package to judge permission
itself, then "was this issued by a person" becomes a question **the package can
answer for itself** — and there is no reason whatsoever to trust it to answer it.
Main is the only place that knows the envelope's source, and the only place that
should make this judgement.

What the package does after receiving `allowWrite: false` is the package's
business; but it has **no** way to claim on its own that this one came from a
person.

### 2.5 How each driver implements it

| driver | `allowWrite: false` | `allowWrite: true` | notes |
|---|---|---|---|
| PostgreSQL | `BEGIN READ ONLY` (today's behaviour) | `BEGIN` (read-write) | all three places have to change (`:137` / `:188` / `:203`); missing one is a silently writable path |
| MySQL | `SET SESSION TRANSACTION READ ONLY` | do not send that statement | per checkout |
| SQLite | **see below** | **see below** | the only awkward one |

**SQLite is the asymmetric one.** Its read-only state is the flag used to open the
file, one handle can only be one of the two, and it cannot be switched per call.
Two ways out:

- **(a) Open it writable + `PRAGMA query_only = ON/OFF` before every query.**
  Workable (`query_only` is connection-scoped and changeable at runtime), and the
  cost is **a downgraded guarantee**: from "the kernel refuses to write this file"
  down to "a PRAGMA we remembered to send". Forget it once and it is writable.
- **(b) Open two handles**, one read-only and one writable, chosen by
  `allowWrite`. The cost is twice the file-locking surface plus one extra piece of
  connection state, and under WAL mode the visibility between the two handles has
  to be thought through separately.

**Recommending (a), and turning "was it sent" into an assertion** (§4, item 3).
The reason is that (b)'s two handles would give "what is this connection" two
answers, and that is precisely the shape Peek has been avoiding everywhere else.

### 2.6 The sidebar's switch

It lands in `connectionMenu.ts` (the right-click menu) **and** as a small
permanent marker on the connection row:

- **The menu item**: a checkbox-style `MenuNode`, `Allow agent writes` /
  `允许 AI 修改数据`
- **The marker on the row**: while it is on, the connection row shows a
  continuously visible mark

**Both are required, because "forgot it was on" is this feature's only failure
mode** (§2.2). Putting it in the right-click menu alone hides the state somewhere
you have to open to see; and while §2.2 has already handled forgetting across
sessions by not persisting, the marker on the row handles forgetting within one
session.

Whether `MenuNode` has a checkbox kind today needs checking in `ui/menuModel.ts`;
if it does not, this is the first new node kind this document adds to the `Menu`
primitive, and it follows the rules of
`2026-08-03-context-menu-primitive.md`.

### 2.7 What to say when something is turned away

**A write the agent issues while the switch is off must be distinguishable from
"the database refused".**

Today a write statement on PG that hits `BEGIN READ ONLY` comes back as SQLSTATE
`25006` → `CONFLICT` (`db-postgres/errors.ts:100`'s comment states outright that
Peek caused this on purpose). After the change that path still exists, but it now
has two entirely different causes:

1. **The switch is off** — a person can turn it on, one click away
2. **The database itself refused** — the account lacks permission, the replica is
   read-only, the table is locked

If both come back as the same `CONFLICT`, the agent takes the first for the
second and then either gives up or goes off "to find a way around it" — and
`instructions.ts:138` is at this very moment teaching it not to work around such
things.

So: **while the switch is off, main refuses before handing the request to the
driver**, returning a dedicated error (`FORBIDDEN` + `error.write.agentNotAllowed`)
whose copy says plainly `这条连接没有授权 AI 修改数据，人可以在侧栏打开`. That
layer of the driver never sees the request at all.

### 2.8 Four pieces of copy have to change, one of them a behavioural instruction to the agent

| location | what it says today | why it must change |
|---|---|---|
| `README.md:20` | all data access is read-only | simply untrue |
| `README.md:32` | the feature table's Data access: Read-only… | same, and this is the most-read of them |
| `README.md:597` | Deferred on purpose: write operations | no longer deferred |
| `apps/desktop/src/main/mcp/instructions.ts:138` | No tool writes to a database… **Do not treat that as something to work around.** | **This one is fed to the agent.** The moment the switch ships it is teaching the agent something that is no longer true, and teaching precisely "do not work around a refusal" — after the change this sentence has to become "while the switch is off do not work around it, go ask a person to turn it on" |

That sentence in `instructions.ts` also has to **vary with the state of the
switch**: a connection an agent may write to and one it may not should not hand
the agent the same sentence.

### 2.9 What has to change in PLAN.md

- §1's fourth non-goal, "editing data and writing it back (read-only first, write
  operations left as an interface to add later)" — void
- §4's capability list — add `write`
- §5 `ConnectionState` — add `agentWrites`
- §10's entire "Write operations" entry under "still undecided" — two of its three
  pending decisions are now settled (decision 1 = a connection-level agent switch;
  decision 2 = the agent may write but is bound by the switch), while decision 3
  (how far the audit trail goes) is **still undecided**, see §3.4

## 3. Trade-offs

### 3.1 Why not a "connection-level read-only switch"

That was the plan I proposed in the first round, and the user turned it down:
with the switch off, a person could not write either.

Turning it down was right — it binds two things into one. A person editing their
own database in their own GUI should not have to apply to the tool first; what
needs to be held in check is **the thing acting in a person's place**. In a GUI
where you have to go flip a switch before every data change, the switch will be
permanently on within three days, and then what it protected is gone.

### 3.2 Why not let the package judge by source itself

See §2.4. One more point about the cost: settling it this way makes `allowWrite`
part of the package contract, so `peek-package.json` and `driver.mjs` both have to
move with it, and **the old packages already installed in `~/.peek/packages/` do
not know the field**. An old package receiving `allowWrite: true` will ignore it
and stay read-only — that direction is safe (it fails conservatively), but the
user will see "the switch is on and it still cannot write". Load time has to be
able to tell whether a package declares `write`, and a connection that does not
declare it gets no switch drawn (§2.1).

### 3.3 Why not issue MCP a separate writable token

The problem PLAN §10's decision 2 records is that "the token is all or nothing".
"Issue a second, writable token" looks like the natural fix, but it binds the
authorisation to **the client's identity**, whereas what the user wants is it
bound to **this connection**. The same agent should have different permissions on
two connections (no writes on the production database, writes on the local one),
and a token cannot do that.

Besides, a token is a long-lived thing in configuration and the switch is a
temporary thing flipped in passing — expressing a temporary authorisation with a
long-lived object walks straight back into §2.2's "forgot it was on" failure mode.

### 3.4 This security boundary only holds for the packages Peek ships

**One thing that must be written down**: `allowWrite: false` is **a request passed
to the driver**, not a fence. A third-party package is perfectly free to ignore it
and perform the write anyway — the driver is the thing that executes the
statement.

This is M8 §2.9's bargain (the entry point performs no checks at all; whatever is
installed is what runs) developing onto the write path. So the accurate way to put
it is:

> For the five packages Peek ships, the agent write switch is enforced by the
> server (PG's `BEGIN READ ONLY` and so on). For any third-party package it is a
> convention — a package that wants to violate it can.

**Not planning to fix it**, because the means of fixing it (parsing the SQL the
package sends out) is exactly §1.1's unwinnable game. It goes into README's
Packages and trust section, listed alongside the costs already there.

**One more, added 2026-08-15, and more thoroughgoing than the above.** Users can
now add their own MCP servers to the chat panel in settings
(`2026-08-15-chat-panel-full-capability.md` §3.5). **For those, this switch is not
even a convention** — a user-configured postgres MCP server connects to the
database itself and issues its own statements, the `allowWrite` field never
reaches it, and that server has no idea Peek has such a switch at all.

The accurate grading is therefore three tiers, not two:

| | what `allowWrite` is |
|---|---|
| the five packages Peek ships | a gate, enforced by the server |
| a third-party database package | a convention, which a package can violate if it wants |
| a user-configured MCP server | **not applicable** — it is not on this path |

Also not planning to fix, and also written into README's trust section. Turning on
the built-in file tools (§2.5) has the same effect here: an agent with `Bash` can
just run `psql`.

### 3.5 Auditing (decision 3, still undecided)

What PLAN §10's decision 3 asks is "how far the audit trail goes". This document
**does not settle it**, but records that it now matters more: `ResultMeta.origin`
lives inside a 200-entry cap, and once an agent-issued `DELETE` has rolled out of
that window, Peek can no longer answer who did it.

This need not block opening up writes (a person can delete things too, and the GUI
keeps no ledger for that either), but it should be settled in the next round.

## 4. Verification

1. **PG's read-only regression tests grow into a matrix** (6 cases today, all of
   them assuming read-only). `allowWrite: false` → the write is refused with
   `25006` (the existing assertion); `allowWrite: true` → the same statement
   succeeds and the data really changed. **Both directions are required; testing
   half of it is testing none of it.**
2. **All three `BEGIN` sites need a case.** §2.5 says missing one is a silently
   writable path — `:137` the normal cursor, `:188` `applyTimeouts`'s fallback
   reopen, `:203` `runInMemory`'s fallback. The third matters most: `DECLARE
   CURSOR` does not accept `UPDATE`, so **a write statement necessarily takes the
   `runInMemory` fallback path**, which makes it this document's actual main road
   rather than a corner.
3. **Whether SQLite's `PRAGMA query_only` was sent** (the cost of §2.5's way out
   (a)). The assertion is pinned on "a write statement under `allowWrite: false`
   is refused by SQLite itself", not on "we sent that PRAGMA" — the latter pins to
   our own implementation, the former pins to the result.
4. **Source routing**: the same connection, the same `UPDATE`, `source: 'ui'`
   succeeds, `source: 'mcp'` comes back `FORBIDDEN` while the switch is off (and
   **not** `CONFLICT`, §2.7), and succeeds once the switch is on. This one tests
   everything this document is about, and is the first one that should be written.
5. **Old-package compatibility** (§3.2): a package that does not declare `write`
   gets no switch drawn on its connections.
6. **The sidebar**: with the switch on, the marker on the row really is drawn —
   through `render-probe`, because this is a thing that is **only useful if it can
   be seen** (§2.6).
7. **`instructions.ts` varies with state** (§2.8): the `instructions` text differs
   between the switch's two states, and neither contains "No tool writes to a
   database".

The manual step (the `verify-chat-security.mjs` sort): **have the embedded agent
try to change data while the switch is off, and see what it says after receiving
`FORBIDDEN`**. The whole reason for §2.7 is "do not send it off to find a way
around", and that is something you only learn by actually running it once.
