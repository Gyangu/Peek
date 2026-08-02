import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { configFilePath, generateToken, resolveCommandSource, writeEndpointFile } from '../token'

/* ==================================================================
 * The credential that tells peek's own chat panel apart from everyone else.
 *
 * `CommandSource` has had an `agent` member, and a comment explaining how to
 * wire it, since the enum was written — and until now nothing produced the
 * value. One `createMcpServer`, no `source`, so every MCP request in the process
 * arrived as `mcp`, and `ToolContext`'s docstring described an isolation that did
 * not exist. Two comments in security-relevant places, both describing the
 * intended state as though it were the current one.
 *
 * What made it matter rather than merely untidy: `chat.respondPermission` had no
 * source policy, so once a human put one conversation into `dontAsk`, that
 * panel's agent could answer the permission prompt a *different* conversation was
 * blocked on. The refusal lives in the bus (see `chat-commands.test.ts`); this
 * file covers the half that makes the refusal addressable at all.
 *
 * Design record: docs/design/2026-08-02-agent-source-and-permission-scope.md
 * ================================================================== */

const TOKEN = 'external-token-external-token-ext'
const AGENT = 'agent-token-agent-token-agent-tok'

const CREDS = { token: TOKEN, agentToken: AGENT, externalSource: 'mcp' } as const

describe('a bearer token says who, not just whether', () => {
  test('each credential resolves to its own identity', () => {
    assert.equal(resolveCommandSource(`Bearer ${TOKEN}`, CREDS), 'mcp')
    assert.equal(resolveCommandSource(`Bearer ${AGENT}`, CREDS), 'agent')
  })

  test('the scheme is matched case-insensitively, the token is not', () => {
    assert.equal(resolveCommandSource(`bearer ${AGENT}`, CREDS), 'agent')
    assert.equal(resolveCommandSource(`BEARER ${AGENT}`, CREDS), 'agent')
    assert.equal(resolveCommandSource(`Bearer ${AGENT.toUpperCase()}`, CREDS), null)
  })

  test('nothing else opens the door', () => {
    assert.equal(resolveCommandSource(undefined, CREDS), null)
    assert.equal(resolveCommandSource('', CREDS), null)
    assert.equal(resolveCommandSource('Bearer', CREDS), null)
    assert.equal(resolveCommandSource('Bearer ', CREDS), null)
    assert.equal(resolveCommandSource(`Basic ${TOKEN}`, CREDS), null)
    assert.equal(resolveCommandSource(`Bearer ${TOKEN}x`, CREDS), null)
    // A prefix of a valid token is the classic near-miss; `tokenMatches` compares
    // lengths before contents precisely so this cannot creep through.
    assert.equal(resolveCommandSource(`Bearer ${TOKEN.slice(0, -1)}`, CREDS), null)
  })

  test('the agent credential is never read as the external one', () => {
    // Direction matters. `agent` is the *more* restricted identity — it is
    // refused `chat.respondPermission` — so an agent request mistaken for an
    // external one is the failure that reopens the hole this all exists to
    // close. An external request mistaken for an agent one only loses privilege.
    assert.equal(resolveCommandSource(`Bearer ${AGENT}`, CREDS), 'agent')
    assert.equal(
      resolveCommandSource(`Bearer ${AGENT}`, { ...CREDS, token: AGENT }),
      'agent',
      'even if the two credentials were somehow identical, agent must win the tie',
    )
  })

  test('with no agent credential configured, behaviour is exactly what it was', () => {
    const noAgent = { token: TOKEN, agentToken: null, externalSource: 'mcp' } as const
    assert.equal(resolveCommandSource(`Bearer ${TOKEN}`, noAgent), 'mcp')
    assert.equal(resolveCommandSource(`Bearer ${AGENT}`, noAgent), null)
  })

  test('an explicit externalSource is respected', () => {
    // The option predates this change and some callers set it; resolving must not
    // quietly flatten everyone to `mcp`.
    assert.equal(resolveCommandSource(`Bearer ${TOKEN}`, { ...CREDS, externalSource: 'system' }), 'system')
  })
})

describe('the agent credential stays out of the endpoint file', () => {
  test('nothing written to ~/.peek/mcp.json can be used to impersonate the panel', () => {
    /*
     * The isolation rests entirely on this. `mcp.json` is how an *external*
     * client authenticates, so it is world-readable to anything on the machine
     * that can read the user's home directory — and an agent credential an
     * external client can read is not an identity, it is a costume.
     *
     * Asserted against the file's whole text rather than its keys: the file also
     * carries a ready-to-paste `hint` command with a token embedded in it, which
     * is exactly the sort of place a second token gets copied into by accident.
     */
    const dir = mkdtempSync(join(tmpdir(), 'peek-agent-cred-'))
    try {
      const agentToken = generateToken()
      writeEndpointFile({ configDir: dir, host: '127.0.0.1', port: 7332, path: '/mcp', token: TOKEN })
      const text = readFileSync(configFilePath(dir), 'utf8')

      assert.ok(text.includes(TOKEN), 'the external token is the point of the file and must be in it')
      assert.ok(
        !text.includes(agentToken),
        'the agent credential reached ~/.peek/mcp.json — anything that can read that file could then ' +
          'present itself as peek\'s own chat panel, and `source: "agent"` would stop meaning anything',
      )
      assert.ok(
        !/agenttoken/i.test(text),
        'the endpoint file has grown a field for the agent credential; it must never have one',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
