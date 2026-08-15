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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  buildUserMcpServers,
  CHAT_WORKDIR_NAME,
  PEEK_MCP_SERVER_NAME,
  buildPeekMcpServer,
  ensureChatWorkdir,
} from '../session-config'
import { CLAUDE_DISALLOWED_TOOLS, claudeCodeProfile } from '../profiles'

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
  assert.deepEqual([...CLAUDE_DISALLOWED_TOOLS], disallowed)
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
  //
  // The single source is now the *profile* rather than a module-level function:
  // each agent's sandbox is expressed in the mechanism that agent understands
  // (`_meta` for Claude Code, environment for Codex), so what this pins down is
  // that the manager asks the profile for it instead of assembling one inline.
  const manager = readFileSync(fileURLToPath(new URL('../manager.ts', import.meta.url)), 'utf8')
  assert.match(
    manager,
    /const _meta = this\.#config\.profile\.buildSessionMeta\(/,
    'the sandbox must come from the profile, not be assembled inline',
  )
  for (const method of ['newSession', 'loadSession']) {
    const call = manager.slice(manager.indexOf(`connection.${method}({`))
    assert.ok(call.startsWith(`connection.${method}({`), `${method} is no longer called as an object literal`)
    const body = call.slice(0, call.indexOf('})'))
    assert.match(body, /\b_meta\b/, `${method} must carry the sandbox`)
  }
})

function agentOptions(): Record<string, unknown> {
  const meta = claudeCodeProfile.buildSessionMeta({})
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

test('a chosen directory is used as given, and a missing one is refused rather than created', () => {
  const base = mkdtempSync(join(tmpdir(), 'peek-acp-'))
  try {
    const project = join(base, 'project')
    mkdirSync(project)

    // Used as handed over: not nested under the chat directory, not given a
    // per-agent segment. It is a directory that already existed for its own
    // reasons — see `ensureChatWorkdir` on which of the default's two jobs
    // survived the panel gaining real file tools.
    assert.equal(ensureChatWorkdir(base, 'claude-code', project), project)
    assert.equal(ensureChatWorkdir(base, undefined, project), project)

    // A chosen directory that is not there is a wrong setting to report, not a
    // hole to fill. Creating `~/Projcts/api` because that is what was typed
    // would leave the agent working somewhere the user has never seen.
    const gone = join(base, 'renamed-since')
    assert.throws(() => ensureChatWorkdir(base, undefined, gone))
    assert.equal(existsSync(gone), false)

    // The default half still creates, which is what makes a first launch work.
    assert.ok(existsSync(ensureChatWorkdir(base, 'codex')))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/* ================================================================== */
/* The user's own MCP servers                                          */
/* ================================================================== */

test('a user server becomes an ACP descriptor of the right shape per transport', () => {
  const [http, stdio] = buildUserMcpServers([
    { name: 'docs', transport: 'http', target: 'https://example.com/mcp', authValue: 'Bearer t0ken' },
    { name: 'local', transport: 'stdio', target: '/opt/bin/server', args: ['--flag'] },
  ])

  // `type` tags the HTTP variant; the stdio variant is the untagged member of
  // the union and carries `command`/`args`/`env` instead, all three required by
  // the protocol even when empty.
  assert.deepEqual(http, {
    type: 'http',
    name: 'docs',
    url: 'https://example.com/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer t0ken' }],
  })
  assert.deepEqual(stdio, { name: 'local', command: '/opt/bin/server', args: ['--flag'], env: [] })
})

test('the credential is sent verbatim under the header the user named', () => {
  const [server] = buildUserMcpServers([
    { name: 'api', transport: 'http', target: 'https://x/mcp', authHeader: 'X-API-Key', authValue: 'raw-key' },
  ])
  // No scheme is prepended. A server expecting a bare key must get a bare key,
  // and peek cannot tell which kind it is talking to — so the user writes the
  // whole value, `Bearer ` included when it is wanted.
  assert.deepEqual((server as { headers: unknown }).headers, [{ name: 'X-API-Key', value: 'raw-key' }])

  // No credential means no header at all, rather than an empty one: an
  // `Authorization: ` that is present and blank is a different request from one
  // that omits it, and servers do tell them apart.
  const [none] = buildUserMcpServers([{ name: 'open', transport: 'http', target: 'https://x/mcp' }])
  assert.deepEqual((none as { headers: unknown }).headers, [])
})
