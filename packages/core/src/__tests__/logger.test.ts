import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  LOG_LEVELS,
  LOG_NAMESPACES,
  createLogger,
  formatLogLine,
  levelAtLeast,
  noopLogger,
  parseLogLevel,
  type LogRecord,
} from '../index'

/**
 * The pure half of logging: levels, filtering, and the one line that lands in
 * `peek.log`.
 *
 * What is worth pinning here is not that a logger logs. It is the three
 * decisions the rest of the system leans on:
 *
 *  - **`minLevel` is read per call**, so the panel's level picker can change what
 *    is captured without a restart. A logger that snapshotted the level at
 *    construction would keep filtering against a number that stopped being true,
 *    and nothing else in the system would notice.
 *  - **`formatLogLine` never throws.** It runs inside other people's catch
 *    blocks; a detail that will not serialise has to degrade, not escalate.
 *  - **`with()` is a copy, not a mutation.** Two conversations logging at once
 *    must not be able to overwrite each other's tag.
 */

function collect(): { sink: (record: LogRecord) => void; records: LogRecord[] } {
  const records: LogRecord[] = []
  return { sink: (record) => records.push(record), records }
}

describe('log levels', () => {
  test('levelAtLeast orders the four', () => {
    assert.equal(levelAtLeast('error', 'debug'), true)
    assert.equal(levelAtLeast('debug', 'error'), false)
    assert.equal(levelAtLeast('warn', 'warn'), true)
  })

  test('parseLogLevel accepts the four and refuses everything else', () => {
    for (const level of LOG_LEVELS) assert.equal(parseLogLevel(level), level)
    // `null` rather than a throw or a default, so each caller decides: a typo in
    // `PEEK_LOG_LEVEL` is worth a word, a typo in `settings.json` is not.
    assert.equal(parseLogLevel('verbose'), null)
    assert.equal(parseLogLevel('DEBUG'), null)
    assert.equal(parseLogLevel(3), null)
    assert.equal(parseLogLevel(undefined), null)
  })

  test('the namespace list and the union agree', () => {
    // A namespace added to the type but not to the array would silently vanish
    // from the panel's filter, which is the kind of gap nobody notices.
    assert.equal(new Set(LOG_NAMESPACES).size, LOG_NAMESPACES.length)
    assert.ok(LOG_NAMESPACES.includes('agent'))
  })
})

describe('createLogger', () => {
  test('drops anything below the current minimum', () => {
    const { sink, records } = collect()
    const log = createLogger({ ns: 'app', sink, minLevel: () => 'warn' })
    log.log('debug', 'nope')
    log.log('info', 'nope')
    log.log('warn', 'yes')
    log.log('error', 'yes')
    assert.deepEqual(records.map((r) => r.message), ['yes', 'yes'])
  })

  test('reads the minimum on every call, so the level can change mid-session', () => {
    const { sink, records } = collect()
    let level: 'debug' | 'info' = 'info'
    const log = createLogger({ ns: 'agent', sink, minLevel: () => level })

    log.log('debug', 'before')
    assert.equal(records.length, 0)

    // What the panel's picker does. Nothing is reconstructed and nothing already
    // captured is lost — the next call simply passes the new filter.
    level = 'debug'
    log.log('debug', 'after')
    assert.deepEqual(records.map((r) => r.message), ['after'])
  })

  test('with() stamps a tag and leaves the parent alone', () => {
    const { sink, records } = collect()
    const base = createLogger({ ns: 'agent', sink, minLevel: () => 'debug' })
    const one = base.with('chat_1')
    const two = base.with('chat_2')

    one.log('info', 'a')
    two.log('info', 'b')
    base.log('info', 'c')

    assert.deepEqual(records.map((r) => r.tag), ['chat_1', 'chat_2', undefined])
  })

  test('omits absent members rather than writing undefined', () => {
    const { sink, records } = collect()
    createLogger({ ns: 'bus', sink, minLevel: () => 'debug' }).log('info', 'plain')
    assert.deepEqual(Object.keys(records[0]!).sort(), ['level', 'message', 'ns', 'ts'])
  })

  test('noopLogger discards, and stays a noop through with()', () => {
    noopLogger.log('error', 'into the void')
    noopLogger.with('tag').log('error', 'also the void')
  })
})

describe('formatLogLine', () => {
  const at = Date.parse('2026-08-15T09:14:02.113Z')

  test('lays out timestamp, level, namespace, tag and message', () => {
    const line = formatLogLine({ ts: at, level: 'warn', ns: 'agent', tag: 'chat_7f3a', message: 'unknown:tool_stream' })
    assert.equal(line, '2026-08-15T09:14:02.113Z  WARN   agent     [chat_7f3a]  unknown:tool_stream')
  })

  test('omits the tag when there is none', () => {
    const line = formatLogLine({ ts: at, level: 'info', ns: 'app', message: 'starting' })
    assert.ok(!line.includes('['))
  })

  test('indents a detail under its line', () => {
    const line = formatLogLine({ ts: at, level: 'error', ns: 'conn', message: 'failed', detail: { code: 42 } })
    assert.equal(line.split('\n')[1], '  {')
    assert.ok(line.includes('"code": 42'))
  })

  test('keeps an Error stack', () => {
    const error = new Error('boom')
    const line = formatLogLine({ ts: at, level: 'error', ns: 'app', message: 'threw', detail: error })
    assert.ok(line.includes('boom'))
  })

  test('never throws on a detail that will not serialise', () => {
    // A circular object, a BigInt and a function each defeat `JSON.stringify` in
    // a different way. A log line must not be the thing that raises — it runs
    // inside somebody else's catch block, and throwing here would replace a
    // diagnosable failure with an undiagnosable one.
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    for (const detail of [circular, 1n, (): void => undefined]) {
      const line = formatLogLine({ ts: at, level: 'error', ns: 'app', message: 'x', detail })
      assert.ok(line.startsWith('2026-08-15T09:14:02.113Z'))
    }
  })

  test('a detail of null is rendered, not treated as absent', () => {
    const line = formatLogLine({ ts: at, level: 'info', ns: 'app', message: 'x', detail: null })
    assert.ok(line.includes('null'))
  })
})
