# Scrubbing the private identifiers that have nothing to do with peek

> 2026-08-03. Three kinds of string unrelated to the peek project itself are
> scattered through the repository: another project's reverse domain, another
> business database's table and database names, and the author's own machine
> username and home path. None of them is part of the design; they were copied in
> from live data while writing tests and the packaging script.

> **Every old name in this document is written in a regex form such as `car[a]`.**
> This change rewrites git history along with the tree (§2.3), and had this
> document written the literals, it would itself become the only hit for the next
> search — a document *recording a cleanup* would be the one thing the cleanup
> missed. A pair of brackets keeps the regex matching and the literal absent.

---

## 1. What this fixes

### 1.1 Three kinds of foreign string

| kind | how it appears | where |
|---|---|---|
| another project's identity | `io.human[i]fy.peek` | `BUNDLE_ID` in `apps/desktop/scripts/package-mac.mjs` |
| another business database's table names | `car[a]` / `car[a]_id` / `memory_[i]nstance` / `car[a]_agent` | the db-postgres test fixture, three test files, the connection-book test, two design documents |
| this machine's identity | the username `g[y]` in Postgres connection strings, `-Users-g[y]--peek-chat` in a document | six test files, `2026-08-02-chat-session-management.md` |

The second kind's origin is already written up in
`2026-08-02-postgres-test-fixture.md` §1.2: the assertions used to read the
`public` schema of a business database on the author's machine. That round fixed
**where the tables come from** (a self-building, self-cleaning fixture) and
copied **their names** across, so the business semantics in those names have
survived until now.

### 1.2 Why this deserves a round of its own

None of these strings affects behaviour, but every one of them is a false signal
to whoever reads the code:

- That bundle ID makes the built `.app` register on macOS under another
  organisation's identity. Launch Services, TCC permission grants and `defaults`
  domains all file by bundle ID, so hanging the wrong name on it is genuinely
  hanging it wrong.
- Table names carrying business semantics make the fixture look as though it
  tests some domain model, when all the fixture needs is three shapes: a parent
  table, a child table with a `created_at`, and a table with a jsonb column.
  Semantic names obscure the assertions it actually exists to feed.
- `postgresql://<this machine's username>:hunter2@…` reads as a real connection
  string. It is test data.

### 1.3 Boundary (explicitly not done)

- **No implementation code changes.** Everything lands in test fixtures, test
  data, one constant in the packaging script, and documents.
- **Paths like `~/.peek` do not change.** That is peek's own configuration
  directory, part of the design rather than a foreign object.
- **The git author identity does not change.** `Gyangu <…@users.noreply.github.com>`
  is the author's own public identity and belongs in the commit record.
- **The `peek_test_pg` / `peek_test_host` schema names are untouched.** They are
  already the project's own naming, with a dedicated justification in
  `2026-08-02-postgres-test-fixture.md` §2.2.

---

## 2. The plan

### 2.1 The mapping

| old | new | why |
|---|---|---|
| `io.human[i]fy.peek` | `io.github.gyangu.peek` | `io.github.<username>` is the common form for an open-source project, points at the author's GitHub identity, and needs no domain actually held |
| fixture table `car[a]` | `account` | the parent table, with only `id` and `name`, referenced by foreign keys from the other two |
| fixture table `harness` | `item` | the child table, 5 rows, whose column order and `created_at` are read directly by assertions. The word itself is not foreign (see §3); it changes along for naming consistency across the three tables |
| fixture table `memory_[i]nstance` | `document` | the one with the jsonb `payload` |
| foreign key column `car[a]_id` | `account_id` | follows its parent |
| constant `HARNESS_ROWS` | `ITEM_ROWS` | follows the table name |
| row ids `h1…h5` / `c1` / `m1` | `i1…i5` / `a1` / `d1` | follows the table names; confirmed that no assertion reads these literals |
| test database name `car[a]_agent` | `orders` | used in the connection-book test as "an ordinary database name" |
| test username `g[y]` | `app` | the user portion of every `postgresql://…` / `postgres://…` in test data |
| `-Users-g[y]--peek-chat` | changed to describe how the path is composed, without writing the path | the sentence is about "the SDK builds a directory name from the cwd", and the specific username is not the point |

The new table names sort as `account` / `document` / `item`, so
`FIXTURE_TABLES` has to be reordered — it is compared directly by
`assert.deepEqual(….sort(), [...FIXTURE_TABLES])`.

### 2.2 Files involved

```
apps/desktop/scripts/package-mac.mjs                      one BUNDLE_ID line
packages/db-postgres/src/__tests__/fixture.ts         DDL + two exported constants + the file header comment
packages/db-postgres/src/__tests__/postgres.test.ts   table and column assertions
packages/db-postgres/src/__tests__/host.test.ts       table assertions
packages/db-postgres/src/__tests__/sql.test.ts        the example table names used to assemble SQL
apps/desktop/src/main/bus/__tests__/connection-book.test.ts              database and user names
packages/core/src/__tests__/connection-label.test.ts                     usernames
apps/desktop/src/renderer/components/__tests__/connection-rows.test.ts   usernames
apps/desktop/src/main/mcp/__tests__/{layout-tools,receipt-catalog-text,cancel-tool}.test.ts  usernames
docs/design/2026-08-02-postgres-test-fixture.md           table names (§1.2 / §2.3 / §2.4)
docs/design/2026-08-02-chat-session-management.md         the local machine path
```

### 2.3 History is rewritten too

These strings are already in committed history (three feature commits brought in
the bundle ID, the database name and the connection strings respectively).
Changing only the working tree leaves `git log -S` and GitHub's code search able
to dig them back out.

So after the working tree is changed and committed,
`git filter-repo --replace-text` replaces all of these strings across every
historical blob according to §2.1's mapping.

The replacement uses regular expressions rather than literals, because the local
username is only two letters: replacing it literally would strike inside words
like `energy` and `gyangu`. The patterns are constrained to the forms it appears
in: `postgresql://…`, `postgres://…`, `user: '…'`.

The cost, plainly: **every commit hash changes**. This repository currently has
one author and no other clones, so the cost is manageable; once there are
collaborators, this route is no longer available.

---

## 3. Trade-offs

**Why not change only the working tree and leave history** — the requirement is
that these must not appear in git, and both `git log -S` and GitHub's code search
reach historical blobs. Changing only HEAD hides the problem rather than solving
it. Conversely, if this repository already had other clones, the recommendation
would invert — rewriting history would then cost more than it buys.

**Why this document writes `car[a]` rather than the literal** — see the note at
the top. This is the self-reference problem peculiar to "a document recording a
deletion": to say what was deleted, the document has to mention it, and mentioning
it means it was not deleted cleanly. Brackets are the lightest answer, and much
less work than maintaining a search allowlist for this one document.

**Why the bundle ID is `io.github.gyangu` rather than `com.peek`** — a reverse
domain says who is responsible for the ID. `com.peek` claims to hold `peek.com`,
which is somebody else's domain — the same class of error as the original, with a
different victim. `io.github.<username>` is underwritten by GitHub's namespace and
is the one spelling that holds without owning an additional asset.

**Why the fixture tables are `account` / `item` / `document` rather than `t1` /
`t2` / `t3`** — the assertions read column order, `created_at`'s type, and
whether the primary key is text, which only mean anything across three
differently shaped tables. The names should hint "these are three different
shapes", which `t1/t2/t3` cannot. But they should not hint at some domain model
either, so the three blandest words win.

**Why `harness` is renamed along with the others but is not treated as a foreign
string** — it did come from the same business database as the other two, but
`harness` is a word with **plenty of legitimate use** in this repository: the
`./harness` module in db-sql's tests, and the `Harness` interface in
`manager.test.ts`, neither related to that database. So it changes only along with
the fixture, for naming consistency across three tables; **it does not enter
§2.3's history replacement table**, which would break those legitimate uses. That
is also why it is absent from §4's scan patterns — adding it would return a screen
of false positives.

---

## 4. Verification

The brackets turn out to be executable here: the patterns below match the old
strings while the commands themselves contain none of them, so pasting these
lines into a terminal will not turn up this document.

```bash
# 1. these three kinds are gone from the working tree (should print nothing)
rg -in --hidden -g '!.git' 'human[i]fy|\bcar[a]\b|car[a]_agent|car[a]_id|memory_[i]nstance' .
rg -n "postgres(ql)?://g[y]\b|user: 'g[y]'|-Users-g[y]-" -g '!.git' .

# 2. the tests are still green (renaming the fixture must change no assertion's conclusion)
pnpm --filter @peek/db-postgres test
pnpm -r test

# 3. history is clean too (all three should print nothing)
git log --oneline --pickaxe-regex -S 'human[i]fy'
git log --oneline --pickaxe-regex -S 'car[a]_agent'
git log --oneline --pickaxe-regex -S 'postgresql://g[y]'

# 4. the packaging script knows the new bundle ID
rg -n 'BUNDLE_ID' apps/desktop/scripts/package-mac.mjs
```

Item 2 is **the only place this round can go wrong**: miss one assertion while
renaming the fixture and the tests go red. Items 1 and 3 are the round's purpose
itself.

---

## 5. Addendum (2026-08-24): one was missed, and why §4 did not catch it

The pre-open-source review found `-Users-g[y]-<a private project>` at
`2026-08-03-chat-history-ownership.md:301` — hitting two of §1.1's kinds at once:
the machine account name, and the name of another body of business.

**Why it was missed**: §2.2's file list names
`2026-08-02-chat-session-management.md`. The
`2026-08-03-chat-history-ownership.md` written the same day cites **a different**
slug and was never listed. The one that was listed was changed per §2.1's
conclusion to "describe how the slug is composed, without writing the path"; the
one that was not stayed as it was until today.

**§4's check is itself correct; nobody ran it.** Item 1's working-tree check hits
that line on today's tree — which is to say this document published the method
and the counterexample together: a reader taking §4's commands and running them
once finds the very thing it meant to hide.

**What was done this time**:

- That line is changed to the descriptive form, matching §2.1's conclusion for its
  sibling document.
- History was rewritten with `filter-repo --replace-text`. Note that §2.3's
  patterns **cannot be reused directly**: they were deliberately narrowed to the
  `postgresql://…` / `user: '…'` shapes, because the account name is two letters
  and a broad match would swallow `gyangu` too. This time the match is on the
  complete slug token.
- Eight `claude/*` refs, two `refs/codex/*` refs and two feature branches already
  merged into master were deleted and pruned. They stop before the scrub and carry
  the **complete** original identifier set (`io.humanif[y].peek`, connection
  strings with passwords, and that business's table names), and
  `git push --all` or `--mirror` would have pushed them all out at once. §4's item
  3 uses `git log --pickaxe-regex` **without `--all`**, so it looked only at
  master and those refs were always outside its field of view.

**A correction to §4**: all three history checks need `--all`, and the ref list
needs one extra confirmation before publishing — "master is clean" and "the
repository is clean" are two different things, and this round left a tail
precisely by taking the first for the second.
