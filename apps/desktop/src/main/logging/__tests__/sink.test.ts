import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { createLogFileWriter, rotatedPath } from '../sink'

/**
 * The rotating writer.
 *
 * These are the cases the design note admits are the real cost of not using
 * `pino` or `electron-log`: rotation's edges. One of the three — concurrent
 * appends — cannot happen by construction, because main is the only writer (every
 * other process reaches this through stdio forwarding). The other two are here.
 *
 * The last test is the one that matters most and looks least impressive:
 * **logging must never be the thing that takes the app down.** This writer is
 * called from inside other people's catch blocks, so an exception out of it
 * replaces a diagnosable failure with an undiagnosable one.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peek-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(path: string, options: { maxBytes?: number; keep?: number } = {}) {
  return createLogFileWriter({
    path,
    maxBytes: options.maxBytes ?? 200,
    keep: options.keep ?? 3,
    // Synchronous in tests: the buffering is main's concern, and a test that
    // slept 200ms per assertion would be testing `setTimeout`.
    maxBufferBytes: 1,
  })
}

describe('rotatedPath', () => {
  test('puts the number before the extension', () => {
    // `peek.log.1` is a file most editors treat as binary; `peek.1.log` still
    // opens with whatever the user has associated with `.log`.
    assert.equal(rotatedPath('/x/peek.log', 1), '/x/peek.1.log')
    assert.equal(rotatedPath('/x/commands.jsonl', 2), '/x/commands.2.jsonl')
  })
})

describe('the log file writer', () => {
  test('appends lines and adds the newline the caller left off', () => {
    const path = join(dir, 'peek.log')
    const writer = write(path)
    writer.write('one')
    writer.write('two\n')
    writer.close()
    assert.equal(readFileSync(path, 'utf8'), 'one\ntwo\n')
  })

  test('creates the directory, and the file is not world-readable', () => {
    const path = join(dir, 'nested', 'peek.log')
    const writer = write(path)
    writer.write('secret-ish')
    writer.close()
    assert.ok(existsSync(path))
    // 0600. The file can hold connection strings, table names and query text —
    // the same argument `mcp.json` makes for its own mode.
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  test('rotates once the file would exceed its ceiling', () => {
    const path = join(dir, 'peek.log')
    const writer = write(path, { maxBytes: 40 })
    writer.write('a'.repeat(30))
    writer.write('b'.repeat(30))
    writer.close()

    assert.ok(existsSync(rotatedPath(path, 1)), 'the previous file was kept')
    assert.ok(readFileSync(rotatedPath(path, 1), 'utf8').startsWith('a'))
    assert.ok(readFileSync(path, 'utf8').startsWith('b'), 'the live file holds the newest')
  })

  test('keeps exactly `keep` files and drops what falls off the end', () => {
    const path = join(dir, 'peek.log')
    const writer = write(path, { maxBytes: 20, keep: 3 })
    for (const letter of ['a', 'b', 'c', 'd', 'e']) writer.write(letter.repeat(30))
    writer.close()

    assert.ok(existsSync(path))
    assert.ok(existsSync(rotatedPath(path, 1)))
    assert.ok(existsSync(rotatedPath(path, 2)))
    // `keep: 3` means three files in total, live one included.
    assert.ok(!existsSync(rotatedPath(path, 3)))
  })

  test('heals after the file is deleted underneath it', () => {
    // Somebody cleaning up `~/.peek/logs` by hand, or a temp cleaner. The writer
    // tracks the live size rather than stat-ing on every flush, so this is
    // exactly where that bookkeeping could go wrong and silently stop rotating.
    const path = join(dir, 'peek.log')
    const writer = write(path)
    writer.write('before')
    unlinkSync(path)
    writer.write('after')
    writer.close()

    const body = readFileSync(path, 'utf8')
    assert.equal(body, 'after\n', 'the new file starts clean rather than resuming a stale offset')
  })

  test('rotates correctly after a heal, rather than carrying the old size forward', () => {
    const path = join(dir, 'peek.log')
    const writer = write(path, { maxBytes: 40 })
    writer.write('a'.repeat(30))
    unlinkSync(path)
    // If the deleted file's 31 bytes were still on the books, this would rotate
    // immediately and leave an empty live file behind.
    writer.write('b'.repeat(20))
    writer.close()
    assert.equal(readFileSync(path, 'utf8'), `${'b'.repeat(20)}\n`)
    assert.ok(!existsSync(rotatedPath(path, 1)))
  })

  test('a write that cannot land is reported once and never thrown', () => {
    // The path is a directory, so every append fails. What is being pinned is
    // that `write` stays silent to its caller: this runs on the dispatch path of
    // every command in the app.
    const path = join(dir, 'blocked')
    const errors: unknown[] = []
    const writer = createLogFileWriter({
      path: join(path, 'peek.log'),
      maxBytes: 100,
      keep: 2,
      maxBufferBytes: 1,
      onError: (error) => errors.push(error),
    })
    writeFileSync(path, 'not a directory')

    assert.doesNotThrow(() => {
      writer.write('one')
      writer.write('two')
      writer.write('three')
    })
    writer.close()
    // Once, not once per line: a full disk fails every subsequent write, and a
    // handler that speaks every time turns one problem into two.
    assert.equal(errors.length, 1)
  })

  test('close is idempotent and stops accepting writes', () => {
    const path = join(dir, 'peek.log')
    const writer = write(path)
    writer.write('kept')
    writer.close()
    writer.close()
    writer.write('dropped')
    writer.close()
    assert.equal(readFileSync(path, 'utf8'), 'kept\n')
  })
})
