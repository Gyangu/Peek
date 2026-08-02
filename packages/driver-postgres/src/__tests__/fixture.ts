import pg from 'pg'

/**
 * The tables the integration suites assert against, created and dropped by the
 * suites themselves.
 *
 * Before this module the assertions named three tables — account / harness /
 * document — that lived in the `public` schema of one business database
 * on one machine. Nothing in the repository created them, so `pnpm -r test`
 * failed here on every other machine, and because pnpm's recursive run stops at
 * the first non-zero exit, **no package after this one ran at all**.
 *
 * Two properties are worth stating, because they are the reason for the shape:
 *
 * - **DDL cannot go through the driver.** Every transaction it opens is
 *   `SET TRANSACTION READ ONLY`, so the fixture reaches past it with a bare
 *   `pg.Client`. That the driver rejects these statements is itself part of the
 *   read-only guarantee.
 * - **The schema name is fixed per suite, not random.** `before` drops and
 *   recreates, so a run killed halfway leaves nothing that the next run has to
 *   clean up — and no sweeping logic that could delete a concurrent run's
 *   schema by mistake.
 *
 * Design record: docs/design/2026-08-02-postgres-test-fixture.md
 */

/** Every table the fixture creates, sorted — the suites assert against this exact set. */
export const FIXTURE_TABLES = ['account', 'harness', 'document'] as const

/** Rows in `harness`. Pagination takes two pages of two and compares them, so this must exceed 4. */
export const HARNESS_ROWS = 5

/**
 * Column order, nullability and types here are all read by assertions:
 * `describeCollection` checks the order, `created_at` must be a NOT NULL
 * timestamptz, and `id` must be a text primary key so `peekValue` can address a
 * row by `pk: { id }` and get a string back.
 */
function ddl(schema: string): string {
  const q = quoteIdent(schema)
  const rows = Array.from(
    { length: HARNESS_ROWS },
    (_, i) => `('h${String(i + 1)}', 'c1', 'name-${String(i + 1)}')`,
  ).join(', ')
  return `
    CREATE SCHEMA ${q};

    CREATE TABLE ${q}.account (
      id   text PRIMARY KEY,
      name text
    );

    CREATE TABLE ${q}.document (
      id      text PRIMARY KEY,
      account_id text REFERENCES ${q}.account(id),
      payload jsonb
    );

    CREATE TABLE ${q}.harness (
      id         text        PRIMARY KEY,
      account_id    text        REFERENCES ${q}.account(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      name       text
    );

    INSERT INTO ${q}.account (id, name) VALUES ('c1', 'fixture');
    INSERT INTO ${q}.harness (id, account_id, name) VALUES ${rows};
    INSERT INTO ${q}.document (id, account_id, payload) VALUES ('m1', 'c1', '{"k":1}');
  `
}

/**
 * Drop any leftover, then build the fixture. Returns a disposer for `after`.
 *
 * Idempotent on purpose: the drop-then-create makes a run that died halfway
 * indistinguishable from a clean machine.
 */
export async function createFixture(url: string, schema: string): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(dropSql(schema))
    await client.query(ddl(schema))
  } finally {
    await client.end()
  }
  return async () => {
    const cleanup = new pg.Client({ connectionString: url })
    await cleanup.connect()
    try {
      await cleanup.query(dropSql(schema))
    } finally {
      await cleanup.end()
    }
  }
}

function dropSql(schema: string): string {
  return `DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`
}

/**
 * The schema name is a constant in each suite rather than user input, but it is
 * still interpolated into DDL, and a test helper that quotes correctly is one
 * fewer example of string-built SQL for anyone to copy.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
