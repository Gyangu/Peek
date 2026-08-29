import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ERROR_MESSAGE_KEYS,
  formatMessage,
  peekError,
  peekErrorMsg,
  placeholdersOf,
  type Message,
  type PeekError,
} from '@peek/core'
import { CATALOGS } from '../catalog'
import { LOCALES, type Locale } from '../locales'
import { localizeError } from '../error'
import { getLocale, setLocale } from '../store'
import { translate, translateDynamic, tStatic } from '../translate'

/* ==================================================================
 * The catalog is only half type-checked by design: translations are plain
 * strings, so nothing stops zh-CN from interpolating {n} where English
 * interpolates {count}. These tests close that hole, and they are what makes
 * adding a third language safe — the parity checks iterate LOCALES, so a new
 * catalog is covered the moment it is registered.
 * ================================================================== */

const ALL: readonly Locale[] = LOCALES.map((l) => l.id)
const REFERENCE: Locale = 'en'

function shapeOf(message: Message): 'plural' | 'string' {
  return typeof message === 'string' ? 'string' : 'plural'
}

describe('catalog parity', () => {
  const referenceKeys = Object.keys(CATALOGS[REFERENCE]).sort()

  it('every locale defines exactly the same keys', () => {
    for (const locale of ALL) {
      assert.deepEqual(
        Object.keys(CATALOGS[locale]).sort(),
        referenceKeys,
        `catalog ${locale} does not have the same keys as ${REFERENCE}`,
      )
    }
  })

  it('every locale uses the same string-vs-plural shape per key', () => {
    for (const locale of ALL) {
      for (const key of referenceKeys) {
        assert.equal(
          shapeOf(CATALOGS[locale][key]!),
          shapeOf(CATALOGS[REFERENCE][key]!),
          `${locale} / ${key}: plural shape differs from ${REFERENCE}`,
        )
      }
    }
  })

  it('every locale interpolates the same placeholders per key', () => {
    for (const locale of ALL) {
      for (const key of referenceKeys) {
        const expected = [...placeholdersOf(CATALOGS[REFERENCE][key]!)].sort()
        const actual = [...placeholdersOf(CATALOGS[locale][key]!)].sort()
        assert.deepEqual(actual, expected, `${locale} / ${key}: placeholder set differs from ${REFERENCE}`)
      }
    }
  })

  it('plural messages always supply the "other" form', () => {
    for (const locale of ALL) {
      for (const key of referenceKeys) {
        const message = CATALOGS[locale][key]!
        if (typeof message === 'string') continue
        assert.equal(typeof message.other, 'string', `${locale} / ${key}: missing the "other" form`)
      }
    }
  })

  it('covers every error key main is allowed to emit', () => {
    for (const key of ERROR_MESSAGE_KEYS) {
      for (const locale of ALL) {
        assert.ok(CATALOGS[locale][key] !== undefined, `catalog ${locale} is missing ${key}`)
      }
    }
  })
})

/* ==================================================================
 * Every key the renderer asks for must exist.
 *
 * Parity above compares the catalogs to each other, which is the check that
 * lets this whole class of bug through: renaming a key in *both* locales keeps
 * parity perfectly green and breaks every call site at once. That happened —
 * `chat.tool.peek.*` became `chat.tool.Peek.*` when the brand was capitalised
 * (a key is an identifier, not front matter), and the chat panel spent a
 * release rendering `chat.tool.peek.open_view` at the reader instead of
 * "Opened a view". Nothing failed, because an unknown key renders as itself and
 * a string that looks like a string looks fine to every test that was watching.
 *
 * So this reads the source rather than the catalog. Only literal keys can be
 * checked; the ~30 computed ones are the price, and they are computed from
 * prefixes that literal siblings already pin.
 * ================================================================== */
describe('call sites', () => {
  const RENDERER = fileURLToPath(new URL('../..', import.meta.url))
  /** `t('a.b.c')` and `tStatic('a.b.c')`; a computed key does not match and is skipped. */
  const CALL = /\bt(?:Static)?\(\s*'([A-Za-z0-9_.-]+)'/g

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') sources(full, out)
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  it('every literal key in the renderer is defined in the catalog', () => {
    const missing: string[] = []
    let seen = 0
    for (const file of sources(RENDERER)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(CALL)) {
        const key = m[1]
        if (key === undefined) continue
        seen += 1
        if (!(key in CATALOGS[REFERENCE])) missing.push(`${file.slice(RENDERER.length)}: ${key}`)
      }
    }
    // A scan that matches nothing passes every assertion after it. Renaming `t`
    // or restructuring the renderer must break this line, not silently retire
    // the check — the same failure the shipped-CSS audit had to be rescued from.
    assert.ok(seen > 400, `the scan found only ${String(seen)} literal keys; the regex has stopped matching`)
    assert.deepEqual(missing, [], `keys asked for but never defined:\n${missing.join('\n')}`)
  })
})

describe('interpolation', () => {
  it('substitutes named params', () => {
    assert.equal(translate('en', 'status.connected', { ready: 2, total: 3 }), '2/3 connected')
    assert.equal(translate('zh-CN', 'status.connected', { ready: 2, total: 3 }), '2/3 已连接')
  })

  it('leaves an unmatched placeholder verbatim so the bug is visible', () => {
    assert.equal(formatMessage('Loaded {n} rows', 'en', {}), 'Loaded {n} rows')
  })

  it('does not reformat numbers — grouping stays the caller decision', () => {
    assert.equal(formatMessage('{n}', 'en', { n: 1234567 }), '1234567')
  })
})

describe('plurals', () => {
  it('English selects one vs other', () => {
    assert.equal(translate('en', 'status.rows', { count: 1, rows: '1' }), '1 row')
    assert.equal(translate('en', 'status.rows', { count: 0, rows: '0' }), '0 rows')
    assert.equal(translate('en', 'status.rows', { count: 1_000_000, rows: '1,000,000' }), '1,000,000 rows')
  })

  it('Chinese falls back to the single "other" form for every count', () => {
    assert.equal(translate('zh-CN', 'status.rows', { count: 1, rows: '1' }), '1 行')
    assert.equal(translate('zh-CN', 'status.rows', { count: 42, rows: '42' }), '42 行')
  })

  it('a view description nests the kind label inside a plural sentence', () => {
    // What StatusBar#describeViewLocalized builds for a tree view. The English
    // reads like core's describeView(); the point is that zh-CN does not.
    const en = { kind: translate('en', 'view.kind.tree'), count: 3 }
    assert.equal(translate('en', 'view.describe.tree', en), 'Object tree · 3 nodes expanded')
    assert.equal(translate('en', 'view.describe.tree', { ...en, count: 1 }), 'Object tree · 1 node expanded')
    assert.equal(
      translate('zh-CN', 'view.describe.tree', { kind: translate('zh-CN', 'view.kind.tree'), count: 3 }),
      '对象树 · 已展开 3 个节点',
    )
  })
})

describe('locale switching', () => {
  it('tStatic follows the active locale and setLocale notifies', () => {
    const seen: Locale[] = []
    setLocale('en')
    assert.equal(tStatic('panel.empty'), 'Empty panel')

    setLocale('zh-CN')
    seen.push(getLocale())
    assert.equal(tStatic('panel.empty'), '空面板')

    setLocale('en')
    assert.equal(getLocale(), 'en')
    assert.deepEqual(seen, ['zh-CN'])
  })

  it('an unknown key renders as the key itself, never as blank text', () => {
    assert.equal(translateDynamic('en', 'nope.not.a.key'), undefined)
  })
})

describe('error localization', () => {
  it('peekErrorMsg carries canonical English plus the descriptor', () => {
    const err = peekErrorMsg('NOT_FOUND', 'error.conn.notFound', { connId: 'c_7' })
    assert.equal(err.code, 'NOT_FOUND')
    assert.equal(err.message, 'Connection c_7 does not exist')
    assert.deepEqual(err.i18n, { key: 'error.conn.notFound', params: { connId: 'c_7' } })
  })

  it('localizes a peek-authored error into the active locale', () => {
    const err = peekErrorMsg('NOT_FOUND', 'error.conn.notFound', { connId: 'c_7' })
    assert.equal(localizeError('en', err), 'Connection c_7 does not exist')
    assert.equal(localizeError('zh-CN', err), '连接 c_7 不存在')
  })

  it('shows driver text verbatim in every locale', () => {
    const raw = peekError('QUERY_FAILED', 'relation "usres" does not exist', { driverCode: '42P01' })
    assert.equal(raw.i18n, undefined, 'driver errors must not claim to be translatable')
    assert.equal(localizeError('zh-CN', raw), 'relation "usres" does not exist')
  })

  it('falls back to the English message when the key is unknown to this build', () => {
    const skewed: PeekError = {
      code: 'INTERNAL',
      message: 'Something from a newer driver host',
      i18n: { key: 'error.from.the.future' },
    }
    assert.equal(localizeError('zh-CN', skewed), 'Something from a newer driver host')
  })
})
