import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AUTO_REFRESH_PRESETS_MS,
  MAX_AUTO_REFRESH_MS,
  MIN_AUTO_REFRESH_MS,
  REFRESHABLE_VIEW_KINDS,
  ViewPatchSchema,
  VIEW_KINDS,
  isRefreshableViewKind,
  refreshPatch,
  type CollectionRef,
} from '../index'

/**
 * The contract half of auto-refresh: which views may carry an interval, what
 * counts as a legal one, and what a refresh sends.
 *
 * The interesting assertion is the *negative* one, and it is weaker than it first
 * looks. `autoRefreshMs` is present on only four of the seven `ViewPatchSchema`
 * branches — but zod objects strip unknown keys rather than rejecting them, here
 * as everywhere else in this file, so a chat patch carrying an interval **parses
 * successfully with the field gone**. That is the guarantee worth pinning: the
 * field cannot reach a view that has nowhere to put it. A TypeScript caller is
 * stopped a step earlier, by the type; a JSON caller is answered with silence
 * rather than an error, which is the same answer every other stray key gets.
 *
 * Design record: docs/design/2026-08-03-auto-refresh.md
 */

const REFUSING_KINDS = VIEW_KINDS.filter((k) => !isRefreshableViewKind(k))

describe('which view patches accept an interval', () => {
  test('the four fetching kinds do', () => {
    assert.deepEqual([...REFRESHABLE_VIEW_KINDS], ['table', 'query', 'vector', 'package'])
    for (const kind of REFRESHABLE_VIEW_KINDS) {
      const parsed = ViewPatchSchema.safeParse({ kind, autoRefreshMs: 5_000 })
      assert.equal(parsed.success, true, `${kind} accepts an interval`)
    }
  })

  test('the three that cannot fetch drop it on the floor', () => {
    assert.deepEqual([...REFUSING_KINDS], ['inspector', 'tree', 'chat'])
    for (const kind of REFUSING_KINDS) {
      const parsed = ViewPatchSchema.safeParse({ kind, autoRefreshMs: 5_000 })
      assert.equal(parsed.success, true, `${kind} parses — unknown keys are stripped, not rejected`)
      assert.equal(
        parsed.success && 'autoRefreshMs' in parsed.data,
        false,
        `${kind} carries no interval out of the parse`,
      )
    }
  })

  test('null is a value — it means off — and an absent field means "leave it alone"', () => {
    assert.equal(ViewPatchSchema.safeParse({ kind: 'table', autoRefreshMs: null }).success, true)
    const bare = ViewPatchSchema.safeParse({ kind: 'table' })
    assert.equal(bare.success, true)
    assert.equal(bare.success && 'autoRefreshMs' in bare.data && bare.data.autoRefreshMs !== undefined, false)
  })
})

describe('what counts as a legal interval', () => {
  test('the bounds are inclusive', () => {
    assert.equal(ViewPatchSchema.safeParse({ kind: 'query', autoRefreshMs: MIN_AUTO_REFRESH_MS }).success, true)
    assert.equal(ViewPatchSchema.safeParse({ kind: 'query', autoRefreshMs: MAX_AUTO_REFRESH_MS }).success, true)
  })

  test('anything outside them is refused, including a fractional millisecond', () => {
    for (const bad of [0, -1_000, MIN_AUTO_REFRESH_MS - 1, MAX_AUTO_REFRESH_MS + 1, 1_500.5]) {
      assert.equal(
        ViewPatchSchema.safeParse({ kind: 'query', autoRefreshMs: bad }).success,
        false,
        `${bad} is refused`,
      )
    }
  })

  test('every preset the menu offers is one the schema accepts', () => {
    for (const ms of AUTO_REFRESH_PRESETS_MS) {
      assert.equal(ViewPatchSchema.safeParse({ kind: 'table', autoRefreshMs: ms }).success, true, `${ms}`)
    }
  })

  test('the presets are ascending and distinct, so the menu reads as a scale', () => {
    const sorted = [...AUTO_REFRESH_PRESETS_MS].sort((a, b) => a - b)
    assert.deepEqual([...AUTO_REFRESH_PRESETS_MS], sorted)
    assert.equal(new Set(AUTO_REFRESH_PRESETS_MS).size, AUTO_REFRESH_PRESETS_MS.length)
  })
})

describe('what a refresh sends', () => {
  const relation: CollectionRef = { kind: 'relation', schema: 'public', name: 'orders' }
  const keyPattern: CollectionRef = { kind: 'keyPattern', pattern: 'user:*' }

  test('a relation refreshes in place', () => {
    assert.deepEqual(refreshPatch(relation), { kind: 'table' })
  })

  test('a cursor-paged collection refreshes back to the first page', () => {
    // `offset` is what makes main drop the continuation token; without it a
    // refresh would re-run the scan from where the last page ended — that is, it
    // would page forward under the name of refreshing.
    assert.deepEqual(refreshPatch(keyPattern), { kind: 'table', offset: 0 })
  })

  test('whatever it produces is a patch the schema accepts', () => {
    for (const ref of [relation, keyPattern]) {
      assert.equal(ViewPatchSchema.safeParse(refreshPatch(ref)).success, true)
    }
  })
})
