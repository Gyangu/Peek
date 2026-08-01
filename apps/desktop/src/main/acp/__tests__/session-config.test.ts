/**
 * Tests for the `session/new` inputs.
 *
 * Small surface, but two of the traps in the whole feature live here: the bearer
 * header is an **array** of `{name, value}` rather than an object, and a missing
 * endpoint must produce `null` rather than a plausible-looking descriptor —
 * `session/new` does not fail on an unreachable MCP server, so a wrong answer
 * here becomes an agent that silently cannot see the window.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  AGENT_DISALLOWED_TOOLS,
  CHAT_WORKDIR_NAME,
  PEEK_MCP_SERVER_NAME,
  buildAgentSessionMeta,
  buildPeekMcpServer,
  ensureChatWorkdir,
} from '../session-config'

test('the descriptor carries the token as an Authorization header entry', () => {
  const descriptor = buildPeekMcpServer({ url: 'http://127.0.0.1:7332/mcp', token: 'tok_abc' })
  assert.deepEqual(descriptor, {
    type: 'http',
    name: PEEK_MCP_SERVER_NAME,
    url: 'http://127.0.0.1:7332/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer tok_abc' }],
  })
  assert.ok(Array.isArray(descriptor?.headers), 'headers is an array, not an object')
})

test('the server name is what the tool prefix is built from', () => {
  // Tools arrive as mcp__<name>__<tool>; the UI strips this exact prefix.
  assert.equal(`mcp__${PEEK_MCP_SERVER_NAME}__read_workspace`, 'mcp__peek__read_workspace')
})

test('a missing endpoint yields null rather than a half-built descriptor', () => {
  assert.equal(buildPeekMcpServer(null), null)
  assert.equal(buildPeekMcpServer({ url: '', token: 'tok' }), null)
  assert.equal(buildPeekMcpServer({ url: 'http://127.0.0.1:7332/mcp', token: '' }), null)
})

/* ================================================================== */
/* The sandbox                                                         */
/* ================================================================== */

/*
 * These four assertions are a security boundary, not a style preference.
 *
 * Measured before the sandbox existed: a chat panel whose own dropdown read "Ask
 * every time" executed a shell command with no prompt, because the session had
 * inherited the *user's* Claude Code permission allowlist; the same session could
 * see `mcp__postgres__execute_sql`, i.e. arbitrary un-gated SQL, which defeats
 * peek's read-only guarantee outright. With this `_meta` the same probe produces
 * zero tool calls and the session sees only `mcp__peek__*`.
 */
test('the session declares filesystem-settings isolation', () => {
  const options = agentOptions()
  assert.deepEqual(
    options['settingSources'],
    [],
    'settingSources must be empty: anything else inherits the user’s own settings, MCP servers and permission allowlist',
  )
})

test('no built-in agent tools are offered, and the dangerous ones are refused by name', () => {
  const options = agentOptions()
  assert.deepEqual(options['tools'], [], 'tools: [] is the SDK’s "disable all built-in tools"')
  const disallowed = options['disallowedTools']
  assert.ok(Array.isArray(disallowed))
  for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Read']) {
    assert.ok(disallowed.includes(tool), `${tool} must be refused by name as well as absent from the preset`)
  }
  assert.deepEqual([...AGENT_DISALLOWED_TOOLS], disallowed)
})

test('inherited MCP servers are dropped without touching peek’s own descriptor', () => {
  // The agent merges `{...options.mcpServers, ...params.mcpServers}`, so an empty
  // object here empties the inherited side and leaves the `session/new` parameter
  // (peek's endpoint, the closed loop) alone.
  assert.deepEqual(agentOptions()['mcpServers'], {})
})

test('both ways of bringing a session up are given the sandbox', () => {
  // A source-level check on purpose: the object above is only a security boundary
  // if it reaches the agent, and nothing else in this suite can spawn one to
  // observe that. Both halves have to move together or this goes red.
  //
  // `session/load` is checked beside `session/new` because a resumed conversation
  // is exactly as much of a sandbox question as a fresh one — it runs the same
  // tools with the same permissions, and an unsandboxed load would inherit the
  // user's global Claude Code configuration just as surely.
  const manager = readFileSync(fileURLToPath(new URL('../manager.ts', import.meta.url)), 'utf8')
  assert.match(
    manager,
    /const _meta = buildAgentSessionMeta\(\)/,
    'the sandbox must come from buildAgentSessionMeta, not be assembled inline',
  )
  for (const method of ['newSession', 'loadSession']) {
    const call = manager.slice(manager.indexOf(`connection.${method}({`))
    assert.ok(call.startsWith(`connection.${method}({`), `${method} is no longer called as an object literal`)
    const body = call.slice(0, call.indexOf('})'))
    assert.match(body, /\b_meta\b/, `${method} must carry the sandbox`)
  }
})

function agentOptions(): Record<string, unknown> {
  const meta = buildAgentSessionMeta()
  const claudeCode = meta['claudeCode'] as Record<string, unknown> | undefined
  assert.ok(claudeCode, 'the sandbox rides under _meta.claudeCode')
  const options = claudeCode['options'] as Record<string, unknown> | undefined
  assert.ok(options, 'the sandbox rides under _meta.claudeCode.options')
  return options
}

test('the working directory is created under the config dir and is absolute', () => {
  const base = mkdtempSync(join(tmpdir(), 'peek-acp-'))
  try {
    const dir = ensureChatWorkdir(base)
    assert.equal(dir, join(base, CHAT_WORKDIR_NAME))
    assert.ok(existsSync(dir))
    assert.ok(statSync(dir).isDirectory())
    // The agent rejects a relative path outright.
    assert.ok(dir.startsWith('/') || /^[A-Za-z]:/.test(dir))
    // Calling twice is fine; the panel reopens across restarts.
    assert.equal(ensureChatWorkdir(base), dir)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
