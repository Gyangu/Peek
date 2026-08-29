import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createScrubber } from '../scrub'

/**
 * The backstop between a diagnostic line and the disk.
 *
 * PLAN §7 ("the token does not go into logs") is kept at the **call sites** — a
 * token is never handed to a log call in the first place. This is the accident-catcher, and the
 * distinction matters enough that the last test in this file asserts the limit
 * rather than the capability: a pattern matcher cannot stop a shape it has never
 * seen, and a reader who believes otherwise will eventually log something in a
 * shape nobody anticipated.
 *
 * The registered-literal path is the one that is not a guess, which is why the
 * MCP token is registered at the moment the server is created.
 */

describe('registered literals', () => {
  test('masks a remembered secret wherever it appears', () => {
    const scrubber = createScrubber()
    scrubber.remember('super-secret-token-value')
    const out = scrubber.scrub('connecting with super-secret-token-value and again super-secret-token-value')
    assert.ok(!out.includes('super-secret-token-value'))
    assert.equal(out.match(/\*\*\*/g)?.length, 2)
  })

  test('ignores a value too short to be a secret', () => {
    // Otherwise registering `""` — or a one-character placeholder — would blank
    // every line. The floor is `redact`'s own rule, restated at the door.
    const scrubber = createScrubber()
    scrubber.remember('abc')
    scrubber.remember('')
    scrubber.remember(null)
    assert.equal(scrubber.scrub('abc is fine here'), 'abc is fine here')
  })
})

describe('shapes', () => {
  const scrubber = createScrubber()

  test('an Authorization header is taken to the end of the line', () => {
    // Not to the next space: a header value may contain spaces, and leaving the
    // tail of a token behind is the same as leaving the token behind.
    const out = scrubber.scrub('Authorization: Bearer abcdefghijklmnop qrstuv')
    assert.equal(out, 'Authorization: ***')
  })

  test('a bare bearer token', () => {
    assert.equal(scrubber.scrub('sent bearer abcdefghijklmnop'), 'sent Bearer ***')
  })

  test('assignment shapes stop at the delimiter', () => {
    // Unlike the header case these sit inside structures, so swallowing to the
    // end of the line would redact the JSON that follows.
    assert.equal(
      scrubber.scrub('{"password": "hunter2", "host": "db.example"}'),
      '{"password": ***, "host": "db.example"}',
    )
    assert.equal(scrubber.scrub('api_key=abc123&limit=10'), 'api_key=***&limit=10')
    assert.equal(scrubber.scrub('token: xyz'), 'token: ***')
  })

  test('credentials inside a URL', () => {
    const out = scrubber.scrub('postgres://alice:hunter2@db.example:5432/app')
    assert.ok(!out.includes('hunter2'))
    assert.ok(out.includes('alice'), 'the user survives; only the credential goes')
    assert.ok(out.includes('db.example:5432/app'))
  })

  test('leaves ordinary text alone', () => {
    const line = 'query.run finished in 12ms over 3 rows'
    assert.equal(scrubber.scrub(line), line)
    // "password" as prose, with nothing assigned to it, is not a secret.
    assert.equal(scrubber.scrub('the password prompt was cancelled'), 'the password prompt was cancelled')
  })
})

describe('the limit, stated', () => {
  test('an unregistered secret in an unanticipated shape survives', () => {
    // This is not a bug being pinned — it is the boundary being documented in a
    // place that fails if somebody quietly starts relying on the opposite. The
    // rule is "do not log secrets", and this file is the seatbelt, not the road.
    const scrubber = createScrubber()
    assert.equal(
      scrubber.scrub('the thing the user typed was sk-live-9f3a2b1c8d7e6f5a'),
      'the thing the user typed was sk-live-9f3a2b1c8d7e6f5a',
    )
  })
})
