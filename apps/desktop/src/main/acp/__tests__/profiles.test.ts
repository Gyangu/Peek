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
  DEFAULT_ACP_PROFILE_ID,
  claudeCodeProfile,
  codexProfile,
  profileById,
} from '../profiles'

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
  assert.equal(claudeCodeProfile.env({ executablePath: '/usr/local/bin/claude' })['CLAUDE_CODE_EXECUTABLE'], '/usr/local/bin/claude')
  assert.equal(codexProfile.env({ executablePath: '/usr/local/bin/codex' })['CODEX_PATH'], '/usr/local/bin/codex')
  // One field, two names: neither agent should see the other's variable.
  assert.equal(claudeCodeProfile.env({ executablePath: '/x' })['CODEX_PATH'], undefined)
  assert.equal(codexProfile.env({ executablePath: '/x' })['CLAUDE_CODE_EXECUTABLE'], undefined)
})

test('an unknown profile id falls back to the enforced one, never to a weaker sandbox', () => {
  // A settings file naming an agent this build does not have is a wrong setting,
  // not a reason to run something less sandboxed than the user last had.
  assert.equal(profileById('no-such-agent').id, DEFAULT_ACP_PROFILE_ID)
  assert.equal(profileById(undefined).id, DEFAULT_ACP_PROFILE_ID)
  assert.equal(profileById(DEFAULT_ACP_PROFILE_ID).sandbox, 'enforced')
  assert.equal(profileById('codex').id, 'codex')
})

test('every profile states how far peek will vouch for it', () => {
  for (const profile of ACP_PROFILES) {
    assert.ok(profile.displayName.length > 0, `${profile.id} needs a display name for error messages`)
    assert.ok(
      profile.sandbox === 'enforced' || profile.sandbox === 'unverified',
      `${profile.id} must declare a sandbox tier`,
    )
    // The help text is what a user sees when a login fails. peek never collects
    // a credential itself, so every one of these has to point somewhere else.
    assert.ok(profile.authHelp.length > 0, `${profile.id} needs auth help`)
  }
  // Claude Code is `enforced` because `verify-chat-security.mjs` runs a probe
  // against the real agent. Codex stays `unverified` until an equivalent exists;
  // flipping it without writing one is the mistake this guards.
  assert.equal(claudeCodeProfile.sandbox, 'enforced')
  assert.equal(codexProfile.sandbox, 'unverified')
})
