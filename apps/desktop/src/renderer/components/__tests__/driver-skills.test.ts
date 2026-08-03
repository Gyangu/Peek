import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { MAX_SKILL_CHARS } from '@peek/core'
import { DRIVER_MANIFESTS } from '../../../drivers/manifests'
import { MCP_INSTRUCTIONS } from '../../../main/mcp/instructions'

/* ==================================================================
 * The Agent Skill each driver package contributes.
 *
 * A skill is prose a package writes for the model that will drive peek against
 * its database, folded into `MCP_INSTRUCTIONS` (design §2.4bis(f)). Prose has no
 * type, so these are the rules that stand in for one.
 *
 * The rule with teeth is the length cap, and it is worth saying why a cap on
 * documentation is a correctness rule rather than a style preference:
 * `MCP_INSTRUCTIONS` is fixed at `initialize` and read by every model on every
 * session, so **every package's skill is paid for by every user**, including the
 * one who only ever opens PostgreSQL. A budget that tight is what forces a skill
 * to hold only the things a model gets wrong without it.
 * ================================================================== */

const WITH_SKILL = DRIVER_MANIFESTS.filter((m) => m.skill !== undefined)

describe('driver skills', () => {
  test('are contributed by packages, not by the app — so this file is not measuring nothing', () => {
    assert.ok(
      WITH_SKILL.length > 0,
      'no manifest declares a skill. Either the field was removed — in which case delete this ' +
        'file rather than leaving it green — or the manifests stopped being collected.',
    )
  })

  test('every one of them reaches the instructions verbatim', () => {
    // The seam this pins: a manifest can declare a skill and the text can still
    // fail to include it (a filter that reads the wrong field, a join that drops
    // the last entry). The model reads the string, not the manifest.
    for (const m of WITH_SKILL) {
      assert.ok(
        MCP_INSTRUCTIONS.includes(m.skill ?? ''),
        `${m.displayName}'s skill is declared but does not appear in MCP_INSTRUCTIONS`,
      )
      assert.ok(
        MCP_INSTRUCTIONS.includes(m.displayName),
        `${m.displayName}'s skill appears unattributed — a reader cannot tell which database it is about`,
      )
    }
  })

  test('a driver without a skill contributes no heading either', () => {
    // Absent means "nothing here would surprise a model". It must not render as
    // an empty section, which reads as "this database has no rules" rather than
    // "nobody wrote any down".
    for (const m of DRIVER_MANIFESTS) {
      if (m.skill !== undefined) continue
      assert.ok(
        !MCP_INSTRUCTIONS.includes(`${m.displayName}:\n`),
        `${m.displayName} declares no skill but has a heading in the instructions`,
      )
    }
  })

  test('stay under the per-package budget', () => {
    for (const m of WITH_SKILL) {
      const length = (m.skill ?? '').length
      assert.ok(
        length <= MAX_SKILL_CHARS,
        `${m.displayName}'s skill is ${String(length)} chars, over the ${String(MAX_SKILL_CHARS)} budget. ` +
          'Cut it rather than raising the cap: every session pays for this text whether or not the ' +
          'user ever opens this database.',
      )
    }
  })

  test('carry no credential, exactly like mcpConnectExample', () => {
    // Same rule and same reason: it is read verbatim by every connected client,
    // and a model that reads a password will repeat it.
    for (const m of DRIVER_MANIFESTS) {
      for (const [field, text] of [
        ['mcpConnectExample', m.mcpConnectExample],
        ['skill', m.skill ?? ''],
      ] as const) {
        assert.ok(
          !/password|secret|apikey|api[-_ ]key|token/i.test(text),
          `${m.displayName}.${field} mentions a credential`,
        )
      }
    }
  })

  test('are English, because this is model-facing text', () => {
    // The language rule in docs/PLAN.md: `describeView`, `ResultMeta.summary` and
    // this are all read by a model rather than shown in a locale. A CJK
    // character here is the one mechanical signal that somebody translated a
    // string that must not be translated.
    for (const m of WITH_SKILL) {
      assert.ok(
        !/[　-鿿＀-￯]/.test(m.skill ?? ''),
        `${m.displayName}'s skill is not written in English`,
      )
    }
  })

  test('say something specific enough to be worth the tokens', () => {
    // A weak proxy on purpose — no test can judge prose. What it does catch is
    // the failure that actually happens: a placeholder that restates the
    // display name and nothing else.
    for (const m of WITH_SKILL) {
      const skill = m.skill ?? ''
      assert.ok(skill.length > 120, `${m.displayName}'s skill is too short to be telling anyone anything`)
      assert.ok(
        skill.trim() === skill,
        `${m.displayName}'s skill has leading or trailing whitespace, which shifts the joined block`,
      )
    }
  })
})
