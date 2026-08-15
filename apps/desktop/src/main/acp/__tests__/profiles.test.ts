/**
 * Tests for the per-agent profiles.
 *
 * The point of a profile is that peek's Claude-specific knowledge stopped being
 * scattered across three files. These tests pin down the two things that would
 * silently un-scatter it: that each agent gets its sandbox in the mechanism it
 * actually understands, and that neither agent gets the other's.
 *
 * The `_meta` contents themselves are checked in `session-config.test.ts`, which
 * is where the security-boundary reasoning lives.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACP_PROFILES,
  CLAUDE_DISALLOWED_TOOLS,
  DEFAULT_ACP_PROFILE_ID,
  claudeCodeProfile,
  codexProfile,
  profileById,
} from '../profiles'

/* ================================================================== */
/* The default is the old behaviour, byte for byte                     */
/* ================================================================== */

/**
 * The guard rail for `2026-08-15-chat-panel-full-capability.md`.
 *
 * That change makes the sandbox configurable — built-in tools, MCP servers and
 * the working directory all become things a user can turn on. Every one of those
 * switches defaults to off, and this is the executable form of what "off" has to
 * mean: **not "roughly what it used to be", but the same object.**
 *
 * A whole-object `deepEqual` rather than the field-by-field assertions in
 * `session-config.test.ts`, and the difference is the point. Those pin four
 * fields each for its own security reason; this one goes red when a *fifth*
 * appears. A new key that a switch is supposed to gate, leaking into the default
 * because someone spread it in unconditionally, is exactly the mistake that
 * suite cannot see and this one can.
 *
 * So: if this test fails, the question is never "how do I update the expected
 * object". It is "why did an empty configuration stop producing the sandbox".
 */
test('an empty configuration produces exactly the sandbox peek shipped with', () => {
  assert.deepEqual(claudeCodeProfile.buildSessionMeta({}), {
    claudeCode: {
      options: {
        settingSources: [],
        tools: [],
        disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
        mcpServers: {},
      },
    },
  })

  // Codex's half of the same promise. Its sandbox lives in the environment, so
  // the whole environment is pinned for the same reason as the object above.
  assert.deepEqual(codexProfile.buildSessionMeta({}), {})
  assert.deepEqual(codexProfile.env({}), {
    INITIAL_AGENT_MODE: 'read-only',
    NO_BROWSER: '1',
  })
})

test('each agent gets its sandbox in the mechanism it understands, and only that one', () => {
  // Claude Code takes restrictions through `session/new`'s `_meta`; Codex takes
  // them through its environment. Sending either one the other's switch is
  // sending a key to a lock it does not have — and, worse, would read as a
  // sandbox being applied when none is.
  const claudeMeta = claudeCodeProfile.buildSessionMeta({})
  assert.ok(claudeMeta['claudeCode'], 'Claude Code’s sandbox rides in _meta')
  assert.deepEqual(claudeCodeProfile.env({}), {}, 'Claude Code needs no environment switch by default')

  assert.deepEqual(codexProfile.buildSessionMeta({}), {}, 'Codex takes no _meta sandbox')
  const codexEnv = codexProfile.env({})
  assert.equal(codexEnv['INITIAL_AGENT_MODE'], 'read-only', 'Codex’s sandbox is its agent mode')
  assert.equal(codexEnv['NO_BROWSER'], '1', 'peek has no terminal for a browser login flow')
  assert.equal(codexEnv['CODEX_CONFIG'], undefined)
})

test('the executable override reaches each agent under the name that agent reads', () => {
  assert.equal(
    claudeCodeProfile.env({ executablePath: '/usr/local/bin/claude' })['CLAUDE_CODE_EXECUTABLE'],
    '/usr/local/bin/claude',
  )
  assert.equal(
    codexProfile.env({ executablePath: '/usr/local/bin/codex' })['CODEX_PATH'],
    '/usr/local/bin/codex',
  )
  // One field, two names: neither agent should see the other's variable.
  assert.equal(claudeCodeProfile.env({ executablePath: '/x' })['CODEX_PATH'], undefined)
  assert.equal(codexProfile.env({ executablePath: '/x' })['CLAUDE_CODE_EXECUTABLE'], undefined)
})

test('an unknown profile id falls back to the enforced one, never to a weaker sandbox', () => {
  // A settings file naming an agent this build does not have is a wrong setting,
  // not a reason to run something less sandboxed than the user last had.
  assert.equal(profileById('no-such-agent').id, DEFAULT_ACP_PROFILE_ID)
  assert.equal(profileById(undefined).id, DEFAULT_ACP_PROFILE_ID)
  assert.equal(profileById(DEFAULT_ACP_PROFILE_ID).sandbox({}), 'enforced')
  assert.equal(profileById('codex').id, 'codex')
})

test('every profile states how far peek will vouch for it', () => {
  for (const profile of ACP_PROFILES) {
    assert.ok(profile.displayName.length > 0, `${profile.id} needs a display name for error messages`)
    assert.ok(
      profile.sandbox({}) === 'enforced' || profile.sandbox({}) === 'unverified',
      `${profile.id} must declare a sandbox tier`,
    )
    // The help text is what a user sees when a login fails. peek never collects
    // a credential itself, so every one of these has to point somewhere else.
    assert.ok(profile.authHelp.length > 0, `${profile.id} needs auth help`)
  }
  // Claude Code is `enforced` because `verify-chat-security.mjs` runs a probe
  // against the real agent. Codex stays `unverified` until an equivalent exists;
  // flipping it without writing one is the mistake this guards.
  assert.equal(claudeCodeProfile.sandbox({}), 'enforced')
  assert.equal(codexProfile.sandbox({}), 'unverified')
})

/* ================================================================== */
/* The switch                                                          */
/* ================================================================== */

test('the tool switch moves both tool fields together, and nothing else', () => {
  const options = (config: { fullTools?: boolean }): Record<string, unknown> => {
    const meta = claudeCodeProfile.buildSessionMeta(config) as Record<string, Record<string, unknown>>
    return meta['claudeCode']!['options'] as Record<string, unknown>
  }

  const open = options({ fullTools: true })
  assert.equal(open['tools'], undefined, 'the preset is withdrawn, not widened')
  assert.equal(open['disallowedTools'], undefined, 'the refusal list goes with it')

  // The one field the switch may never reach. `settingSources: []` is what keeps
  // the panel identical on every machine, which is what lets the permission
  // dialog mean what it says — and the servers users wanted from inheritance
  // come through peek's own list instead. Design doc §2.3.
  assert.deepEqual(open['settingSources'], [], 'settingSources is not part of the switch')
  assert.deepEqual(open['mcpServers'], {})

  // Half-applied is not a middle position: `tools` replaces and
  // `disallowedTools` accumulates, so a session with one and not the other has
  // a tool set nobody chose.
  const shut = options({})
  assert.ok(Array.isArray(shut['tools']) && Array.isArray(shut['disallowedTools']))
})

test('the switch is reported as a tier, and never launders one agent’s gap into the other’s', () => {
  // `relaxed` is not a third degree of confidence. It says the restrictions were
  // not asked for — which is why it wins over `unverified`, a claim peek has yet
  // to check. Both remain true of a Codex session with the switch on, and the
  // panel says both; the tier reports the decision.
  assert.equal(claudeCodeProfile.sandbox({ fullTools: true }), 'relaxed')
  assert.equal(codexProfile.sandbox({ fullTools: true }), 'relaxed')

  // Codex's switch is its agent mode, and the top tier stays out of reach at
  // every setting: `agent-full-access` drops the workspace boundary and the
  // network restriction both, and nothing peek was asked for needs either.
  assert.equal(codexProfile.env({ fullTools: true })['INITIAL_AGENT_MODE'], 'agent')
  assert.equal(codexProfile.env({})['INITIAL_AGENT_MODE'], 'read-only')
  for (const config of [{}, { fullTools: true }]) {
    assert.notEqual(codexProfile.env(config)['INITIAL_AGENT_MODE'], 'agent-full-access')
  }

  // Claude Code's switch never travels in the environment, and Codex's never in
  // `_meta` — the same separation the first test in this file pins, checked again
  // with the switch on, where a copy-paste between profiles is most tempting.
  assert.deepEqual(claudeCodeProfile.env({ fullTools: true }), {})
  assert.deepEqual(codexProfile.buildSessionMeta({ fullTools: true }), {})
})
