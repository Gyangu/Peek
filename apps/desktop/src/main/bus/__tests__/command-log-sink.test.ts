import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommandLogEntry } from '@peek/core'
import { CommandLog } from '../command-log'

/**
 * What the Command log persists, and the one thing it refuses to record.
 *
 * PLAN §6 has called this log "a recording of the session, replayable and
 * testable" since M2 — while it was a 500-entry array that a process exit
 * erased. The sink is what makes the sentence true, and these tests pin the two
 * ways that could go wrong: a sink that is not called, and a sink that is called
 * so often it destroys the recording it is meant to preserve.
 */

const entry = (name: CommandLogEntry['name'], ok = true): Omit<CommandLogEntry, 'seq'> => ({
  commandId: `cmd_${name}`,
  ts: 1,
  source: 'ui',
  name,
  input: {},
  ok,
  rev: 1,
  elapsedMs: 0,
})

test('every recorded command reaches the sink, in order, with its seq', () => {
  const seen: CommandLogEntry[] = []
  const log = new CommandLog(10, (e) => seen.push(e))

  log.push(entry('view.open'))
  log.push(entry('query.run'))

  assert.deepEqual(seen.map((e) => [e.seq, e.name]), [[1, 'view.open'], [2, 'query.run']])
})

test('reading the log is not itself a command worth recording', () => {
  /*
   * The panel polls `log.readCommands` every two seconds while it is open. If
   * those reads were recorded, the audit would take two entries per second of
   * evidence that somebody is *looking* at it — and at 500 entries, four minutes
   * of an open panel would evict every real command the user opened it to find.
   *
   * A log that a viewer destroys by being viewed is not a log.
   */
  const seen: CommandLogEntry[] = []
  const log = new CommandLog(10, (e) => seen.push(e))

  assert.equal(log.push(entry('log.read')), null)
  assert.equal(log.push(entry('log.readCommands')), null)

  assert.equal(log.size, 0)
  assert.equal(seen.length, 0)
})

test('state.read is deliberately still recorded', () => {
  // The rule is not "read-only commands are boring". `state.read` is an external
  // client reading peek's state, which is a fact about the session worth having;
  // `log.*` is excluded because its only caller is this log's own viewer.
  const log = new CommandLog(10)
  assert.notEqual(log.push(entry('state.read')), null)
  assert.equal(log.size, 1)
})

test('a skipped command does not consume a sequence number', () => {
  // Otherwise `seq` would develop gaps whose only meaning is "the panel was
  // open", and a reader would take those for lost entries.
  const log = new CommandLog(10)
  log.push(entry('view.open'))
  log.push(entry('log.read'))
  const third = log.push(entry('view.close'))
  assert.equal(third?.seq, 2)
})

test('a sink that throws does not cost the in-memory entry', () => {
  // The class must not depend on the good manners of whatever is injected into
  // it: a failing disk is a reason to lose persistence, not a reason to lose the
  // ring the panel is reading.
  const log = new CommandLog(10, () => {
    throw new Error('disk full')
  })
  assert.doesNotThrow(() => log.push(entry('view.open')))
  assert.equal(log.size, 1)
})

test('the ring still evicts oldest-first with a sink attached', () => {
  const seen: CommandLogEntry[] = []
  const log = new CommandLog(2, (e) => seen.push(e))
  log.push(entry('view.open'))
  log.push(entry('view.close'))
  log.push(entry('query.run'))

  assert.deepEqual(log.entries().map((e) => e.name), ['view.close', 'query.run'])
  // The sink saw all three: the file is not bounded by the ring, which is the
  // whole reason for writing one.
  assert.equal(seen.length, 3)
})
