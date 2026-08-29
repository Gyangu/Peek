# The connect dialog's default driver: the window's last compile-time database list

Phase C (`2026-08-07-database-packages-from-disk.md`) moved the six bundled packages into
`~/.peek/packages/` and made them entirely equal to third-party packages — including being
uninstallable (decision 1). This document handles one thing that change left behind:
**the connect dialog still hard-codes `'postgres'`, and once the PostgreSQL package is
uninstalled it takes the whole window down.**

---

## 1. What this fixes

### 1.1 Where things stand: one literal, which is a compile-time list of length 1

`renderer/components/ConnectDialog.tsx`'s `seedFrom()`, the branch taken for a new
connection (no `initial`):

```ts
function seedFrom(initial: SavedConnection | undefined): Seed {
  if (!initial) {
    const mode = defaultConnectMode('postgres')
    return { driverId: 'postgres', mode, values: initialConnectValues('postgres', mode), label: '' }
  }
```

In the same file the driver picker has already been changed to `manifestDriverIds()`, with a
comment reading "a package that is loaded is a package that is offered — there is no second
list of ids to fall out of step with, which is what `DRIVER_IDS` was". **The picker changed;
the seed did not.** So the picker's contents come from disk while its default selection comes
from compile time.

### 1.2 The consequence is not a wrong default, it is a blank window

`defaultConnectMode('postgres')` → `connectForm.ts:82`'s `manifest()` →
`lookupManifest` returns null → `throw new Error('No driver manifest for postgres')`.

That throw happens inside render, and `ErrorBoundary` (`renderer/main.tsx:71`, wrapping the
whole `App`) does what React prescribes: it unmounts the entire tree and replaces it with
"the window has stopped rendering / reload the window". Reloading crashes at the same place
again, because what triggers it is state on disk rather than a one-off.

**And there is no way back — not even once the package-installing UI is finished.** §2.8's
settings panel (Install… / Uninstall / Upgrade / Restore bundled packages) is landing in
parallel, in the same batch of uncommitted changes as this document. But that panel lives
**inside this window**: what `ErrorBoundary` takes over is the whole tree, and the settings
entry point goes with it. So "there is a recovery entry point" does not make this bug
lighter — quite the opposite, it says the cost of the crash is that it also closes the only
route to self-rescue.

Reproduction (measured, against the `pnpm build` output):

1. Point `PEEK_CONFIG_DIR` at a temporary directory and start once, so `<cfg>/packages/` is
   laid out;
2. Delete `<cfg>/packages/postgres` and write `<cfg>/packages/.uninstalled.json` =
   `{"uninstalled":[{"id":"postgres","version":"0.0.1","at":"<iso>"}]}` — the tombstone is
   required, otherwise `layOutBundledPackages` lays it back out on the next start (§2.5
   rule 3);
3. Restart and click the sidebar's `＋`.

`apps/desktop/scripts/cdp.mjs` is the CDP client that drives this window.

### 1.3 The same throw has a second door: editing a connection whose driver has been uninstalled

`connectionMenu.ts:61` offers Edit on every saved connection without consulting the manifest
list. After the package is uninstalled the connection book still lists that record, and **it
renders fine** — `label` / `detail` have been stored on disk since §2.3(b-2) and can be drawn
without the package present. Click Edit → `seedFrom(initial)` →
`connectModeFor(initial.driverId, …)` → the same `manifest()` → the same throw.

This is not a new bug found here, it is a second door onto the same one. Both doors close
together; closing one only moves the blank window to a different click.

### 1.4 The conflict with the design's §1.4, and the decision the documentation owes

The design's §1.4 and `drivers/installed.ts`'s "Empty is a legal state, and it is the loud
one" both say: there is no longer a compile-time database list in the window, what is
installed is what is offered, and nothing installed at all is a legal state. That
`'postgres'` literal violates it head-on.

But **the documentation never said which driver a new connection should default to** — Phase
B did not need it, because the answer was always one of those six. So this is a decision the
documentation owes, not code that is unilaterally wrong. Aligned with the user on
2026-08-11; the conclusion is in §2.1 / §2.2.

### 1.5 Boundary (deliberately not done here)

- **§2.8's settings-panel rework is not implemented** (each row's origin / uninstall /
  upgrade, Install… at the top, Restore bundled packages at the bottom). It is landing in
  parallel and does not belong to this document; this one only guarantees that "the package
  is gone, the window is still there, and it can say why". The two touch at exactly one
  point: this document's copy points at Settings → Databases, because that route now works.
- **`firstRun.connectBody`'s hard-coded database list is not touched** (en and zh both name
  PostgreSQL, MySQL, SQLite, Redis, Qdrant). It is the other face of the same subject — a
  compile-time list inside interface copy — but it is **copy** rather than a lookup, and
  changing it means first deciding whether the first-run guide should be generated from the
  installed packages, which is another round of alignment. Recorded here so the next scan
  does not rediscover it.
- **`loader.ts`'s ordering is not changed** (directory names, `.sort()`). It decides who "the
  first installed driver" is; this document only consumes it.
- **`QueryView.tsx:114`'s `conn?.driverId ?? 'postgres'` is not touched.** It feeds
  `SqlEditor`, ends at `lookupManifest(driverId)?.sqlDialect`, and falls back to
  `StandardSQL` on a miss rather than throwing. It is a default that already degrades, not
  the kind being dismantled here. Recorded here so the next scan does not rediscover it and
  argue it through again.
- **No standalone preference persistence** of the "remember which driver was picked in the
  dialog last time" kind. §2.1 uses the connection book, which is already on disk.

---

## 2. The plan

### 2.1 The default driver: the most recently used one in the connection book that is still installed

For a new connection, `seedFrom` takes, in order:

1. the `driverId` of the entry in `saved` with the newest `lastUsedAt` for which
   `lookupManifest(driverId) !== null`;
2. failing that (the book is empty, or every driver in it has been uninstalled) →
   `manifestDriverIds()[0]`;
3. failing that too (nothing installed at all) → no default driver, see §2.2.

**Why the connection book rather than "the first installed driver"**: the loader sorts by
directory name, and the first driver today is **neo4j** (neo4j → postgres → qdrant → redis →
sql's mysql/sqlite). Pure "first" is the purest reading of §1.4, at the cost of every
PostgreSQL user's default quietly becoming neo4j today — a behaviour change nobody asked
for, and one whose reason (alphabetical order of directory names) is entirely invisible in
the interface.

The connection book neither introduces a compile-time preference nor lets the default drift
from what the user actually connects to: someone who only connects to PostgreSQL still sees
PostgreSQL, and someone who only connects to Redis sees Redis rather than today's postgres.

**It needs no new persisted state.** `SavedConnection` already carries `lastUsedAt`
(`commands.ts:1750`), and `Sidebar` already holds the whole of `saved` (the result of
`conn.book.list`); it only has to be passed into the dialog as a prop. The list is passed
rather than a pre-computed driverId: the algorithm belongs to the dialog's seeding logic, and
the Sidebar should not know what the dialog does with it.

**The "still installed" filter is required**, otherwise once PostgreSQL is uninstalled the
most recently used PostgreSQL record in the book brings §1.2's throw back verbatim — the same
bug from a different source.

### 2.2 Three entry points, two treatments

There are three routes to this dialog, split in two by whether they mean "create" or "already
exists":

| entry point | where | with nothing installed |
|---|---|---|
| the sidebar's `＋` | around `Sidebar.tsx:145` | **disabled**, with `title` giving the reason |
| the first-run guide's Connect a database | Step 1 of `FirstRunGuide.tsx` | **disabled**, the same sentence |
| Edit in the connection row's context menu | `connectionMenu.ts:61` | opens as usual, with a named error inside the dialog (§2.3) |

**The creating entry points are disabled, not "open an empty dialog".** The user decided this
on 2026-08-11. The reason: a dialog with zero options in the picker and zero fields in the
form looks exactly like a rendering bug; a greyed `＋` with one sentence says the same thing
and cannot be misread as a fault.

The cost has to be written down: the reason is hidden in a tooltip, and all that is left in
the interface is a grey button. That cost is acceptable because **it is not the only
telling**: `main/packages/installed.ts:120` already pushes
`No database packages are installed, so no connection can be opened` into the error centre
when the load result is empty, with the packages root attached. The tooltip says *what*, the
error centre says *why and where*, and neither side re-implements the other's judgement.

**The editing entry point is not disabled**, because what §4's verification item 13 settled
for "things that already exist after a package is uninstalled" is exactly "show a named error
rather than a blank window". Hiding the menu item would turn that row into an unexplained
record that cannot be edited; opening the dialog and saying "no database package providing
`<driverId>` is installed" is what that same acceptance criterion looks like in this
interface.

### 2.3 The backstop: this dialog is not allowed to throw

After `seedFrom` there may be no usable driver (nothing installed at all, or
`initial.driverId` uninstalled). In that case `ConnectDialog` draws the dialog shell + one
named error + a close button, and **does not enter the form path** — `connectFormSpec` /
`connectFields` / `initialConnectValues` are none of them called.

This is the last of the layers; the first two (§2.2 disabling the creating entry points, §2.1
filtering out uninstalled drivers) already make the "nothing installed" branch unreachable
today. The reason for keeping it is not a habit of defensive programming, it is the magnitude
of this failure: **any new entry point that misses the check costs the whole window**, and
this dialog has three entry points, which have historically proved that they do not get
updated in step. And the "edit a connection whose driver has been uninstalled" branch is
**genuinely reachable** — it is exactly the state named on §2.2's last row.

### 2.4 `connectForm.ts`'s `manifest()` comment has been falsified and must change

`connectForm.ts:73` currently reads:

> a miss is a wiring bug rather than a state the UI has to handle

After Phase C that sentence is false: uninstalling a package is precisely making it miss, and
the user does it by pressing a button. The function keeps throwing (its callers have indeed
all committed to drawing a form by then), but the comment has to change to spell out **who is
responsible for stopping a miss before it is called** — the seeding step in `ConnectDialog`,
not here.

### 2.5 Copy

Two new keys, one each in en and zh-CN:

- `connect.noPackages` — nothing installed at all. It is at once the disabled `＋`'s `title`,
  the visible hint under step 1 of the first-run guide, and what the backstop dialog says when
  it has no driverId to name. One sentence in three places, because they are saying the same
  thing, and a key for each place would only let the three drift apart over time;
- `connect.driverGone` — the named error in the backstop dialog, with a `{driverId}`
  interpolation.

Both point at Settings → Databases, because §2.8's panel can already install and restore
bundled packages. The driver id itself is not translated (the same rule as the picker's
`<option>`s and the version numbers in the settings panel).

---

## 3. Trade-offs

### 3.1 Default to "the first installed driver" — not chosen

The purest reading of §1.4, zero preference logic, one line of code. The reason against is in
§2.1: the default would become neo4j today, a behaviour change nobody asked for and that the
interface cannot explain either.

It is kept as §2.1's level-2 fallback, where its arbitrariness is reasonable — the connection
book has given no information at all, something has to be picked, and sorting by directory
name is at least stable across machines.

### 3.2 Default to "pick postgres if postgres is installed" — not chosen

Behaviour identical to today's to the letter, the smallest change, and it downgrades the
throw to "use it if it is there, fall back to the first if not". The reason against is that
it leaves §1.1's "compile-time list of length 1" in the window verbatim — merely stopping it
from crashing. What §1.4 wants removed is that literal itself, not only its failure mode.

### 3.3 Draw an empty connect dialog when nothing is installed — vetoed by the user

`drivers/installed.ts`'s comment ("shows an empty connect dialog rather than a plausible one
that is a build behind") points literally at this approach. The user chose to disable the
entry point, for the reason recorded in §2.2: an empty picker and an empty form cannot be
told apart from a rendering bug.

This is not a conflict with `installed.ts` — that sentence argues that a compile-time list
must not be used to pretend the packages are still there, and disabling the entry point
satisfies it just as well, and louder.

### 3.4 Hide the Edit menu item when the driver is missing — not chosen

Less work than opening a dialog that can only report an error. The reason against is in §2.2:
it would turn the connection row into a dead record with no explanation at all, the opposite
of what verification item 13 settled for "things that already exist" — a named error rather
than a blank window.

---

## 4. Verification

### 4.1 Unit: the seed's three-level fallback

A group added under `renderer/components/__tests__/`, testing §2.1's selection function
directly (exported out of the component):

1. the most recently used driver in the book is still installed → pick it;
2. the most recently used driver has been uninstalled and the next newest is still there →
   pick the next newest;
3. the book is empty / every driver in it has been uninstalled → `manifestDriverIds()[0]`;
4. no driver installed at all → answer null rather than throw.

### 4.2 CDP regression: the dialog still opens after its default driver is uninstalled

A new `checkDialogOutlivesItsDrivers` in `scripts/smoke-drivers.mjs`, running after
`hotUninstall('echo')` (last, because it empties this app out). It is not a hard-coded case
but **a loop shaped like the bug**: uninstall the package owning "the driver the dialog had
selected the moment it opened", then ask again, until no package is left. Two assertions per
turn:

1. **the dialog still open when the uninstall happens** must name that driver rather than
   dying along with the window. This is the path where the user clicks uninstall in the
   settings panel while the connect dialog is open, and it is the scenario §2.3's backstop is
   really aimed at;
2. **the reopened dialog**'s selection must be in the list it offers itself — "the default is
   not in its own picker" is precisely this document's whole class of bug.

Finally: once every package is uninstalled, `＋` is `disabled` and **the sidebar is still
there**. What a blank window leaves as its trace is that "`＋` cannot even be found" (the
whole tree replaced by `ErrorBoundary`), so when `＋` cannot be read
`document.body.innerText` is reported alongside it, putting the message that killed the
window straight into the failure output.

**Measured (2026-08-11, the `pnpm build` output + a standalone Electron instance + a
temporary `PEEK_CONFIG_DIR`)**:

```
dialog opened on 'neo4j'   (offers neo4j/postgres/qdrant/redis/mysql/sqlite) → uninstall neo4j
dialog opened on 'postgres'(offers postgres/qdrant/redis/mysql/sqlite)       → uninstall postgres
dialog opened on 'qdrant'  → uninstall qdrant
dialog opened on 'redis'   → uninstall redis
dialog opened on 'mysql'   → uninstall sql (mysql + sqlite go together)
＋ is disabled once nothing is installed, and the window is still rendering
```

Every turn's "the dialog still open names that driver" passed too.

**Reverse verification (also measured)**: change only §2.1's seed back to `'postgres'`
(keeping the backstop and the disabling), rebuild the renderer and run again: the first turn
still passes (the backstop covers the dialog that is already open), and **on the second turn,
reopening the dialog, the window is gone** — reported as `dialog opened with no picker`
immediately followed by `no new-connection button`, that is, the sidebar is entirely absent.
That is exactly the crash being guarded against, which shows this regression tests that crash
itself and not something else.

The run above was on an empty connection book, so it reached §2.1's level 2 (first installed
driver = neo4j). Level 1 was run separately using the echo fixture (which needs no external
server): install echo → `conn.open` an echo connection → the book now holds
`echo@2026-08-11T12:10:00.739Z` → open a blank form, and **the selection is echo rather than
neo4j**. That is precisely the difference §2.1 buys by taking the connection book instead of
"the first installed", and it was measured.

**Current status**: `smoke-drivers.mjs` does not run to completion; it aborts at an earlier
assertion — the one in `hotInstall` about how the settings panel groups its rows ("row groups
must be packages, not drivers"), which belongs to the §2.8 half in parallel progress and is
unrelated to this document. The measurements above were therefore run with an equivalent
standalone runner; once that half closes, `checkDialogOutlivesItsDrivers` will run along with
the whole smoke.

### 4.3 Editing a connection whose driver has been uninstalled

Connect once (entering the book) → uninstall that package → the sidebar row is still there
(`label`/`detail` are stored on disk) → context menu, Edit → the dialog opens and names that
driver as not installed → the window did not crash.

**Measured** (the same run as 4.2's level 1, with echo). Edit is still in the context menu
(§3.4's choice: do not hide the menu item), and once opened the dialog says:

> Edit connection ✕ No installed database package provides "echo", so this connection cannot
> be opened until that package is installed again under Settings → Databases.

Afterwards the sidebar's `＋` can still be found, that is, the window was not replaced by
`ErrorBoundary`.

### 4.4 What must not move

`connect-form.test.ts` and `driver-skills.test.ts` go through `manifestDriverIds()`, and this
document does not touch the data they read. **Run**: `pnpm typecheck` clean, `pnpm test` all
1808 passing (including the 7 added in 4.1), `pnpm build` (with the render probe and both
audits) passing.
