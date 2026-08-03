import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPeekError, type RelationRef } from '@peek/core'
import { mysqlDriver, requireMysqlConfig, requireSqliteConfig, sqliteDriver } from '../driver'
import { mysqlManifest, sqliteManifest } from '../manifest'
import { MYSQL_DIALECT } from '../mysql/dialect'
import { SQLITE_DEFAULT_SCHEMA, SQLITE_DIALECT, sqliteAffinity } from '../sqlite/dialect'
import { parseSqlNodeId, sqlNodeId } from '../introspect'
import { buildScanSql } from '../sql'

/**
 * Contract tests: no database involved. They pin the parts of the dialect layer
 * the rest of the system depends on — the advertised capability sets, quoting,
 * the pieces of SQL where the two dialects genuinely disagree, and the node-id
 * codec — so the M5 implementation cannot drift away from them while filling in
 * the backends.
 */

const users: RelationRef = { kind: 'relation', schema: 'peek_test', name: 'users' }

describe('driver-sql contract', () => {
  it('advertises exactly the capability sets this package declares for itself', () => {
    // Against the package's own manifests, which are what the connect dialog and
    // the MCP tools read before anything has connected. These used to be pinned
    // to a table in core that the driver imported back — self-consistent, and
    // describing the package from outside it.
    assert.deepEqual([...mysqlDriver.capabilities].sort(), [...mysqlManifest.capabilities].sort())
    assert.deepEqual([...sqliteDriver.capabilities].sort(), [...sqliteManifest.capabilities].sort())
    assert.equal(mysqlDriver.meta.id, 'mysql')
    assert.equal(sqliteDriver.meta.id, 'sqlite')
  })

  it('rejects a config routed to the wrong driver', () => {
    assert.equal(requireMysqlConfig({ driverId: 'mysql', url: 'mysql://h/db' }).driverId, 'mysql')
    assert.equal(requireSqliteConfig({ driverId: 'sqlite', file: '/tmp/x.db' }).driverId, 'sqlite')
    try {
      requireMysqlConfig({ driverId: 'sqlite', file: '/tmp/x.db' })
      assert.fail('a sqlite config must not be accepted as mysql')
    } catch (err) {
      assert.ok(isPeekError(err))
      assert.equal(err.code, 'BAD_REQUEST')
    }
  })

  it('quotes identifiers in each dialect’s own style, and refuses what cannot be quoted', () => {
    assert.equal(MYSQL_DIALECT.quoteIdent('user`s'), '`user``s`')
    assert.equal(SQLITE_DIALECT.quoteIdent('user"s'), '"user""s"')
    assert.equal(MYSQL_DIALECT.qualify(users), '`peek_test`.`users`')
    // An empty schema is the connection's default for MySQL, and `main` for SQLite
    assert.equal(MYSQL_DIALECT.qualify({ ...users, schema: '' }), '`users`')
    assert.equal(SQLITE_DIALECT.qualify({ ...users, schema: '' }), '"main"."users"')
    for (const dialect of [MYSQL_DIALECT, SQLITE_DIALECT]) {
      assert.throws(() => dialect.quoteIdent(''))
      assert.throws(() => dialect.quoteIdent(`a${String.fromCharCode(0)}b`))
    }
  })

  it('renders LIMIT/OFFSET the way each database actually requires', () => {
    // MySQL: OFFSET without LIMIT is a syntax error, hence the 2^64-1 sentinel
    assert.equal(MYSQL_DIALECT.renderLimitOffset(undefined, 50, []), ' LIMIT 18446744073709551615 OFFSET 50')
    assert.equal(SQLITE_DIALECT.renderLimitOffset(undefined, 50, []), ' LIMIT -1 OFFSET 50')
    assert.equal(MYSQL_DIALECT.renderLimitOffset(10, 0, []), ' LIMIT 10')
    assert.equal(SQLITE_DIALECT.renderLimitOffset(10, 20, []), ' LIMIT 10 OFFSET 20')
    assert.equal(MYSQL_DIALECT.renderLimitOffset(undefined, 0, []), '')
  })

  it('renders NULL-safe inequality per dialect, and binds every value', () => {
    const mysqlParams: unknown[] = []
    assert.equal(
      MYSQL_DIALECT.renderFilter({ column: 'name', op: 'neq', value: 'x' }, mysqlParams),
      'NOT (`name` <=> ?)',
    )
    assert.deepEqual(mysqlParams, ['x'])

    const sqliteParams: unknown[] = []
    assert.equal(
      SQLITE_DIALECT.renderFilter({ column: 'name', op: 'neq', value: 'x' }, sqliteParams),
      '"name" IS NOT ?',
    )
    assert.deepEqual(sqliteParams, ['x'])

    // `contains` is a literal substring match: a user's % stays a percent sign
    const p: unknown[] = []
    assert.equal(
      MYSQL_DIALECT.renderFilter({ column: 'bio', op: 'contains', value: '100%' }, p),
      'INSTR(`bio`, ?) > 0',
    )
    assert.deepEqual(p, ['100%'])

    // An empty IN list is false, never a dropped predicate
    assert.equal(SQLITE_DIALECT.renderFilter({ column: 'id', op: 'in', value: [] }, []), '0 = 1')
    assert.throws(() => MYSQL_DIALECT.renderFilter({ column: 'id', op: 'in', value: 7 }, []))
    assert.throws(() => MYSQL_DIALECT.renderFilter({ column: 'id', op: 'eq' }, []))
  })

  it('emulates NULLS FIRST/LAST, which neither database spells the PostgreSQL way', () => {
    assert.equal(
      MYSQL_DIALECT.renderOrderBy([{ column: 'at', dir: 'desc', nulls: 'last' }]),
      ' ORDER BY `at` IS NULL ASC, `at` DESC',
    )
    assert.equal(
      SQLITE_DIALECT.renderOrderBy([{ column: 'at', dir: 'asc', nulls: 'first' }]),
      ' ORDER BY "at" IS NULL DESC, "at" ASC',
    )
    assert.equal(SQLITE_DIALECT.renderOrderBy(undefined), '')
  })

  it('builds a scan statement with every value bound', () => {
    const built = buildScanSql(MYSQL_DIALECT, {
      ref: users,
      filter: [{ column: 'age', op: 'gte', value: 18 }],
      sort: [{ column: 'name', dir: 'asc' }],
      columns: ['id', 'name'],
      offset: 200,
      limit: 100,
    })
    assert.equal(
      built.text,
      'SELECT `id`, `name` FROM `peek_test`.`users` WHERE `age` >= ? ORDER BY `name` ASC LIMIT 100 OFFSET 200',
    )
    assert.deepEqual(built.params, [18])
    assert.equal(built.offset, 200)
  })

  it('maps native types to logical types, including the ones that lose data if guessed', () => {
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'bigint' }), 'bigint')
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'bigint unsigned' }), 'bigint')
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'varchar(255)' }), 'string')
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'json' }), 'json')
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'varchar', binary: true }), 'bytes')
    assert.equal(MYSQL_DIALECT.logical({ name: 'n', typeName: 'datetime' }), 'timestamp')

    // SQLite has affinity, not types
    assert.equal(sqliteAffinity('VARCHAR(20)'), 'text')
    assert.equal(sqliteAffinity('INTEGER'), 'integer')
    // SQLite's own worked example: 'FLOATING POINT' gets INTEGER affinity,
    // because rule 1 (contains 'INT') is checked before the REAL rule. The
    // surprise is the database's, and the dialect must reproduce it rather than
    // "fix" it — otherwise peek labels a column differently than SQLite stores it
    assert.equal(sqliteAffinity('FLOATING POINT'), 'integer')
    assert.equal(sqliteAffinity('DOUBLE'), 'real')
    assert.equal(sqliteAffinity(null), 'blob')
    assert.equal(SQLITE_DIALECT.logical({ name: 'n', typeName: 'INTEGER' }), 'bigint')
    assert.equal(SQLITE_DIALECT.logical({ name: 'n', typeName: 'DATETIME' }), 'timestamp')
    // An expression column has no declared type at all
    assert.equal(SQLITE_DIALECT.logical({ name: 'n', typeName: null }), 'unknown')
    assert.equal(SQLITE_DIALECT.nativeTypeName({ name: 'n', typeName: null }), 'any')
  })

  it('reads catalogs from the right place in each database', () => {
    assert.match(MYSQL_DIALECT.listRelationsSql('peek_test').text, /information_schema\.TABLES/)
    assert.deepEqual(MYSQL_DIALECT.listRelationsSql('peek_test').params, ['peek_test'])
    // MySQL's system schemas are filtered out by bound parameters, not by string
    // interpolation
    const schemas = MYSQL_DIALECT.listSchemasSql()
    assert.match(schemas.text, /information_schema\.SCHEMATA/)
    assert.ok(schemas.params.includes('performance_schema'))

    assert.match(SQLITE_DIALECT.listSchemasSql().text, /pragma_database_list/)
    assert.match(SQLITE_DIALECT.listColumnsSql(users).text, /pragma_table_info\(\?, \?\)/)
    assert.deepEqual(SQLITE_DIALECT.listColumnsSql(users).params, ['users', 'peek_test'])
    assert.match(SQLITE_DIALECT.listRelationsSql(SQLITE_DEFAULT_SCHEMA).text, /"main"\.sqlite_master/)
  })

  it('slices large values by bytes, not characters', () => {
    const mysqlParams: unknown[] = []
    assert.equal(
      MYSQL_DIALECT.byteSliceExpr('`body`', 0, 4096, mysqlParams),
      'SUBSTRING(CAST(`body` AS BINARY), ?, ?)',
    )
    // ByteRange is 0-based, SQL is 1-based
    assert.deepEqual(mysqlParams, [1, 4096])
    const sqliteParams: unknown[] = []
    assert.equal(
      SQLITE_DIALECT.byteSliceExpr('"body"', 10, 100, sqliteParams),
      'substr(CAST("body" AS BLOB), ?, ?)',
    )
    assert.deepEqual(sqliteParams, [11, 100])
    assert.equal(MYSQL_DIALECT.byteLengthExpr('`b`'), 'OCTET_LENGTH(`b`)')
  })

  it('enforces read-only at the database, not by parsing the statement', () => {
    assert.ok(MYSQL_DIALECT.sessionSetupSql().includes('SET SESSION TRANSACTION READ ONLY'))
    assert.ok(SQLITE_DIALECT.sessionSetupSql().includes('PRAGMA query_only = 1'))
  })

  it('classifies driver error codes', () => {
    assert.equal(MYSQL_DIALECT.classifyError('ER_PARSE_ERROR', 1064), 'SYNTAX_ERROR')
    assert.equal(MYSQL_DIALECT.classifyError('ER_NO_SUCH_TABLE', 1146), 'NOT_FOUND')
    assert.equal(MYSQL_DIALECT.classifyError('ER_QUERY_INTERRUPTED', 1317), 'CANCELLED')
    assert.equal(MYSQL_DIALECT.classifyError('ER_SOMETHING_NEW', 9999), null)
    // SQLite's err.code says nothing; the numeric result code is what carries meaning
    assert.equal(SQLITE_DIALECT.classifyError('ERR_SQLITE_ERROR', 14), 'CONNECTION_FAILED')
    // Extended result codes are primary | (sub << 8)
    assert.equal(SQLITE_DIALECT.classifyError('ERR_SQLITE_ERROR', 8 | (3 << 8)), 'CONFLICT')
    assert.equal(SQLITE_DIALECT.classifyError('ERR_SQLITE_ERROR', undefined), null)
  })

  it('round-trips node ids, including names containing the separators', () => {
    assert.deepEqual(parseSqlNodeId(sqlNodeId.schema('main')), { kind: 'schema', name: 'main' })
    assert.deepEqual(parseSqlNodeId(sqlNodeId.relation('peek_test', 'a.b:c')), {
      kind: 'relation',
      schema: 'peek_test',
      name: 'a.b:c',
    })
    assert.equal(parseSqlNodeId('nonsense').kind, 'unknown')
    assert.equal(parseSqlNodeId('relation:noseparator').kind, 'unknown')
  })
})
