import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@peek/core'
import { CATALOGS } from '../catalog'
import { LOCALES, type Locale } from '../locales'

/* ==================================================================
 * Package copy may not imply that a package was checked.
 *
 * Design 2026-08-07 §2.9 corollary 1, and acceptance 40. peek runs whatever is
 * in `~/.peek/packages/`: no signature check, no hash check, no permission
 * declaration, no sandbox, no confirmation at install time. That is decision 6,
 * asked twice and answered the same way both times — the boundary is a trust
 * boundary, not a technical one.
 *
 * The rule that follows is about **copy**, and it is not decoration. An install
 * button lowers the bar from "copy a directory into a hidden folder" to "click",
 * and one adjective on that surface — "verified", "safe", "trusted" — turns a
 * decision the user is making into a claim peek is making. §2.9 names
 * DataGrip's "Ignore and Continue" as the shape to avoid: a warning that can
 * always be clicked past teaches people that warnings are things you click past.
 *
 * "Removed", never "completely removed", belongs to the same rule pointing the
 * other way. The directory is gone and the processes that had loaded it were
 * killed, and that is all peek knows; whatever the package wrote elsewhere while
 * it ran is outside what an uninstall button can speak for.
 *
 * ## What this reads, and what it therefore does not cover
 *
 * The catalogs — the actual words — under the prefixes in `PACKAGE_KEY_PREFIXES`.
 * Not `PackagesSection.tsx`, deliberately: the
 * banned words appear in that file's header comment *explaining the ban*, so a
 * source scan would have to be taught to skip comments, and a scanner with an
 * exemption for the file it is guarding is worth less than an honest boundary.
 * Every string that reaches this panel comes through `t()`, so the catalog is
 * where the copy lives. A hardcoded sentence in the JSX would escape this, and
 * that is the gap — named here rather than papered over.
 *
 * §4.8 item 40 called this a review item with no automatable criterion. Half of
 * it is automatable, and this is that half; the other half — "the flow shows no
 * fake progress" — is still a thing a person has to look at.
 * ================================================================== */

const ALL: readonly Locale[] = LOCALES.map((l) => l.id)

/**
 * Which keys carry package copy. A list, not the one prefix this started as.
 *
 * `settings.packages.` is the panel, and the panel is not the only place a user
 * reads a sentence about a package. `connect.noPackages` / `connect.driverGone`
 * are the two states the connect dialog shows when a package is *not* there —
 * both about installing one, both under a different prefix, and both therefore
 * outside the scan until they were named here. They were read by hand instead
 * (design §4sedecies(e) item 2, recorded as a gap in that section's (f) item 7),
 * and reading by hand is what a guard is for.
 *
 * Add a prefix when package copy grows a new home. A prefix that stops matching
 * anything is a key that quietly left the scan, which is what the last test in
 * this file refuses to let happen silently.
 */
const PACKAGE_KEY_PREFIXES = ['settings.packages.', 'connect.noPackages', 'connect.driverGone'] as const

/** Every message under one of those prefixes, one locale at a time. */
function packageCopy(locale: Locale): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  for (const [key, message] of Object.entries(CATALOGS[locale])) {
    if (!PACKAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    for (const text of formsOf(message)) out.push({ key, text })
  }
  return out
}

function formsOf(message: Message): string[] {
  return typeof message === 'string' ? [message] : Object.values(message)
}

/**
 * Words that assert a property of the package rather than describe an act.
 *
 * "Trust" itself is **not** here, and the distinction is the whole point:
 * `trustNote` says installing "is you deciding to trust it", which names who is
 * doing the trusting. "Trusted" would name a property peek had established, and
 * peek establishes none.
 */
const BANNED = [
  'verified',
  'verify',
  'validated',
  'checked',
  'scanned',
  'signed',
  'safe',
  'secure',
  'trusted',
  'trustworthy',
  'completely',
  '已验证',
  '已校验',
  '校验通过',
  '已扫描',
  '安全',
  '可信',
  '完全移除',
  '彻底移除',
]

describe('package copy never claims a package was checked', () => {
  it('no banned word appears in any locale', () => {
    const offenders: string[] = []
    for (const locale of ALL) {
      for (const { key, text } of packageCopy(locale)) {
        const lowered = text.toLowerCase()
        for (const word of BANNED) {
          if (lowered.includes(word))
            offenders.push(`${locale} / ${key}: “${word}” in ${JSON.stringify(text)}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `This copy tells the user a package was inspected, and nothing inspected it ` +
        `(design §2.9 corollary 1, acceptance 40):\n${offenders.join('\n')}\n\n` +
        `Say what happened, not what it means. If the word is genuinely about the user's own ` +
        `decision rather than peek's assurance, the sentence is fine and the word is not — rewrite ` +
        `it, do not shorten this list.`,
    )
  })

  it('every locale still carries the one sentence that states what installing grants', () => {
    // The replacement for the warning that is not there. Its absence would leave
    // the panel silent about a decision it is asking the user to make, which is
    // the failure mode above wearing the opposite disguise.
    for (const locale of ALL) {
      const note = CATALOGS[locale]['settings.packages.trustNote']
      assert.equal(typeof note, 'string', `${locale} has no settings.packages.trustNote`)
      assert.ok(
        typeof note === 'string' && note.length > 40,
        `${locale}'s settings.packages.trustNote is too short to say anything: ${JSON.stringify(note)}`,
      )
    }
  })

  it('the sentence about there being nothing to install is gone', () => {
    // It said "these packages are built into this copy of peek, so there is
    // nothing to install or remove yet". Every word of that is now false, and a
    // key nobody renders is exactly how a false sentence survives to be
    // rendered again by the next person who needs a hint here.
    for (const locale of ALL) {
      assert.equal(
        CATALOGS[locale]['settings.packages.builtinHint'],
        undefined,
        `${locale} still carries settings.packages.builtinHint`,
      )
    }
  })

  it('every prefix still matches copy, so none of them scans nothing', () => {
    // A prefix list is only as good as its aim. Rename a key, drop the one
    // message a prefix was written for, and the scan above still passes — it
    // would just have less to read, and say so nowhere. This is the difference
    // between "no banned word was found" and "no banned word is there".
    for (const locale of ALL) {
      const keys = packageCopy(locale).map(({ key }) => key)
      for (const prefix of PACKAGE_KEY_PREFIXES) {
        assert.ok(
          keys.some((key) => key.startsWith(prefix)),
          `${locale} has no message under “${prefix}”, so that prefix guards nothing. ` +
            `If the key moved, point this list at where it went; if the copy is gone for good, ` +
            `drop the prefix — do not leave it here reading an empty set.`,
        )
      }
    }
  })
})
