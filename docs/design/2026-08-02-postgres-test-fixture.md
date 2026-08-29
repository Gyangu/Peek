# db-postgres's test fixture builds and cleans up after itself

> 2026-08-02. The technical-debt ledger entry (`PLAN.md` §11.2) reading "the
> PostgreSQL test database is not self-built". It came up while trying to run
> `pnpm -r test` for a baseline: **the whole command halted at db-postgres** and
> not one package after it ran. That is a step worse than the ledger's "the
> db-postgres package fails as a whole".

---

## 1. What this fixes

### 1.1 The symptom: one package's environmental dependency blocks the whole repository's tests

`pnpm -r test` runs in topological order, and any package exiting non-zero halts
it with `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`. In today's measured output there is
**exactly one prefix, `packages/db-postgres test:`** — `core`, `db-redis`,
`db-qdrant`, `db-sql` and `desktop` never executed.

So the ledger's "running `pnpm -r test` without this environment variable fails
the db-postgres package as a whole — this is not a regression" understates the
consequence: it does not merely fail itself, it makes **everyone else's
regressions untestable**.

### 1.2 The cause: the assertions describe the contents of one development database on one machine

All seven failures point at the same thing:

| assertion | what it depends on |
|---|---|
| `postgres.test.ts:122` | exactly three tables under `public`, named after three in that business database |
| `postgres.test.ts:165` | the child table among them has four columns, in the order `id, <parent>_id, created_at, name` |
| `postgres.test.ts:184` | that child table is non-empty |
| `postgres.test.ts:214` | that child table has at least 4 rows (pagination takes two pages of 2 with differing contents) |
| `postgres.test.ts:373` | that child table's `id` is a string type |
| `host.test.ts:204` | the same table, once more over RPC |

> Added 2026-08-03: those three table names were copied straight from that
> business database and are foreign identifiers unrelated to peek. They have been
> changed to `account` / `item` / `document` under
> `2026-08-03-scrub-unrelated-identifiers.md`. The SQL and the assertion table
> below use the new names; the renaming changes no assertion's conclusion.

Those tables are not in the repository and no script creates them. They are the
`public` schema of **a business database on the author's machine at the time**.
Any machine without that database — CI included — is necessarily red.

And the fallback URL points at `postgres@localhost/postgres`, an **empty**
default database, which makes the default path the failing path.

### 1.3 Boundary (explicitly not done)

- **The driver implementation does not change.** This round touches
  `src/__tests__/` only, and not a line of the driver.
- **No docker-compose or testcontainers.** The repository has no precedent for
  containerised testing, and introducing an orchestration layer for one package
  is not a fair trade; besides, the `PEEK_TEST_PG_URL` override already exists,
  and which server it points at is the caller's business.
- **The fixture gets nothing beyond what the existing assertions need** (no
  views, materialised views or partitioned tables). `RELATION_SQL` counts `v`,
  `m`, `p` and `f` as relations, so adding a view to the fixture would directly
  overturn the "exactly 3 tables" assertion. Testing views is a separate change
  and does not ride along.
- **A reachable PostgreSQL is still required.** This round solves "does not
  depend on the contents of somebody's database", not "does not depend on a
  server". Genuinely offline still needs the fallback noted in §5.

---

## 2. The plan

### 2.1 The fixture builds in its own schema, not in `public`

A new `packages/db-postgres/src/__tests__/fixture.ts` runs DDL over a bare
`pg.Client`, creating a **schema belonging to this test run** and building the
three tables inside it.

Why a schema and not a database: creating a database needs a second connection to
the `postgres` database and `CREATEDB` rights, and under concurrency
`DROP DATABASE` is blocked by other connections. Creating a schema needs only
`CREATE` on the target database, and `DROP SCHEMA ... CASCADE` clears it in one
statement.

Why the DDL does not go through the driver's own `session.query()`: the driver
issues `SET TRANSACTION READ ONLY` **on every transaction** (part of the
read-only red line), so DDL over it necessarily fails. The fixture has to come in
alongside — which incidentally proves that read-only constraint is real.

### 2.2 The schema name is fixed per test file, not random

```
peek_test_pg     ← postgres.test.ts
peek_test_host   ← host.test.ts
```

`before()` runs `DROP SCHEMA IF EXISTS <name> CASCADE` then `CREATE SCHEMA`, and
`after()` runs the drop again.

Fixed names rather than random or pid-suffixed ones, for **self-healing after a
crash**: a schema left behind by a run killed with ⌃C is simply overwritten by
the next `before()`'s drop-then-create, needing no sweeping logic and
accumulating no garbage. The cost is that one file cannot run twice
concurrently — and `node --test` is one process per file with different names
between files, so that cost does not exist under the current arrangement.

### 2.3 Fixture contents: exactly enough to feed the existing assertions

```sql
CREATE TABLE account (id text PRIMARY KEY, name text);
CREATE TABLE document (id text PRIMARY KEY, account_id text, payload jsonb);
CREATE TABLE item (
  id         text        PRIMARY KEY,
  account_id text        REFERENCES account(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  name       text
);
```

`item`'s column order, `created_at`'s `NOT NULL` and `timestamptz`, and `id`
being the primary key are all read directly by assertions rather than written
casually. Five rows go in (pagination needs two pages of 2 with differing
contents; 5 leaves a little slack), with fixed ids `'h1'…'h5'` — both
`typeof id === 'string'` and `peekValue(pk: { id })` need a text primary key.

### 2.4 The assertions follow: from "what is in public" to "what is in the schema I built"

| was | is |
|---|---|
| `listChildren(nodeId.schema('public'))` | `listChildren(nodeId.schema(FIXTURE_SCHEMA))` |
| `{ kind: 'relation', schema: 'public', … }` | `{ …, schema: FIXTURE_SCHEMA, … }` |
| `rowCountOf('public.item')` | `rowCountOf(\`${FIXTURE_SCHEMA}.item\`)` |
| `call('introspect.children', { parentId: 'schema:public' })` | `parentId: nodeId.schema(FIXTURE_SCHEMA)` |

**One assertion does not change**: `names[0] === 'public'` at
`postgres.test.ts:116`. It looks like an assertion about the database's contents,
but it is actually about the driver's own ordering — `SCHEMA_SQL` ends with
`ORDER BY (n.nspname = 'public') DESC, n.nspname`. It still holds once the fixture
schema exists, and it **becomes more meaningful**: before, the list held only
`public` and "public sorts first" was trivially true; with two entries it finally
tests that `ORDER BY`.

One assertion is added along the way: the fixture schema must appear in the schema
list. That sentence could not be written before — no schema was one the test could
guarantee existed.

### 2.5 Files involved

```
packages/db-postgres/src/__tests__/fixture.ts     new
packages/db-postgres/src/__tests__/postgres.test.ts  assertions + before/after
packages/db-postgres/src/__tests__/host.test.ts      assertions + before/after
```

`close.test.ts` and `sql.test.ts` are untouched: the first only opens and closes
connections, the second is pure functions, and neither reads a table.

---

## 3. Trade-offs

**Why not simply mark these tests skipped** — they are db-postgres's only
coverage against a real server. `sql.test.ts` tests the pure functions that
assemble SQL, and the `isPeekError` classification tests the can't-connect case;
"the cursor really paginated", "the cancel really interrupted" and "a BIGINT
really comes back as a number" can only be answered by a real database. Skipping
takes this driver's verification to zero.

**Why not testcontainers or docker-compose** — see §1.3, plus a cost estimate: it
adds "Docker must be on this machine" as a precondition of `pnpm -r test`, where
the current precondition is "a PostgreSQL must be", and the latter is more common
on a development machine. If CI ever needs it, do it then, rather than guessing
now on CI's behalf.

**Why not build the three tables in `public`** — that is exactly today's shape.
Writing tables into somebody's `public` means deciding, at `DROP` time, which
ones are yours, and one wrong decision deletes their data. A separate schema
turns cleanup into a single `DROP SCHEMA CASCADE`, where **the scope of the
deletion is bounded by the scope of the creation** and no judgement is required.

**Why fixed names rather than `peek_test_<pid>`** — random names leave one behind
per run, with nobody to clean up after a crash. Either sweeping logic is added
("drop everything matching `peek_test_%`", which would kill a concurrent run) or
the leak is accepted. Fixed names make the problem disappear.

---

## 4. Verification

```bash
# one package: the seven failures should go to zero
pnpm --filter @peek/db-postgres test

# whole repository: no longer halts at db-postgres
pnpm -r test

# the fixture really did clean up (should print nothing)
psql "$PEEK_TEST_PG_URL" -Atc \
  "select nspname from pg_namespace where nspname like 'peek\_test\_%';"

# a different database must also pass (proving it no longer depends on one database's contents)
createdb peek_fixture_check
PEEK_TEST_PG_URL=postgresql://postgres@localhost:5432/peek_fixture_check \
  pnpm --filter @peek/db-postgres test
dropdb peek_fixture_check
```

That last one is the **only meaningful acceptance** here: the whole point of a
self-building fixture is that it passes against an empty database. Run against
the old code it is necessarily red.
