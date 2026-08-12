import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LOCALES, type Locale } from '../../../i18n/locales'
import { boundT } from '../../../i18n/translate'
import { elisionLabel } from '../treeElision'

/* ==================================================================
 * The row that admits the tree is incomplete.
 *
 * A redis level stops at PREFIX_SAMPLE_KEYS, and keys past the ceiling are
 * simply absent — so the driver ends such a level with an elision node. Its own
 * `detail` is English because MCP reads it; the sidebar words it here instead,
 * because the reader who most needs this row is the one being told not to trust
 * what is above it.
 *
 * The assertion that matters is the *absence of a number* in the unknown case,
 * in every language. A driver reaches it precisely when it stopped reading
 * before the level ended, so any figure it could print would be a count of what
 * it happened to see, sitting where the reader takes it for what is left.
 * ================================================================== */

const ALL: readonly Locale[] = LOCALES.map((l) => l.id)

describe('how a tree elision is worded', () => {
  test('a counted tail shows its count', () => {
    assert.equal(elisionLabel({ remaining: 40 }, boundT('en')), '40 more, not shown')
    assert.equal(elisionLabel({ remaining: 40 }, boundT('zh-CN')), '还有 40 项未显示')
  })

  test('an uncounted tail carries no digit in any language', () => {
    for (const locale of ALL) {
      const label = elisionLabel({}, boundT(locale))
      assert.ok(label.length > 0, `${locale}: the row must say something`)
      assert.doesNotMatch(label, /\d/, `${locale}: "how much is missing" is not knowable here`)
      // A missing key renders as the key itself (see translate.ts), which would
      // pass the digit check while showing 'tree.elision.unknown' to the user
      assert.doesNotMatch(label, /^tree\./, `${locale}: the key is not a translation`)
    }
  })

  test('the two cases never collapse into the same sentence', () => {
    for (const locale of ALL) {
      const t = boundT(locale)
      assert.notEqual(elisionLabel({ remaining: 0 }, t), elisionLabel({}, t), locale)
    }
  })
})
