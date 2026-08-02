import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KEY_VALUE_SHAPES,
  isKeyValueShape,
  isPeekError,
  keyValueReadOptions,
  type KeyValuePayload,
  type KeyValueResult,
  type KeyValueShape,
  type ValueRef,
} from '@peek/core'
import { nextKeyWindow, windowFieldFor } from '../views/keyWindow'

/* ==================================================================
 * Paging a key/value structure across the process boundary.
 *
 * `nextCursor` is one string standing for three unrelated things, and which one
 * it is depends on the value's shape. The renderer resolves that here; core
 * re-checks it in `keyValueReadOptions` on the far side.
 *
 * The check only worked in one direction. `nextKeyWindow` read the shape, used
 * it to pick a field, and then dropped it; `main/driver-rpc.ts` did not parse
 * the field either. So every window arrived without a shape and core took the
 * branch that *infers* the addressing back — which cannot tell a stream's entry
 * id from a hash cursor, and called every stream page a map's.
 *
 * See docs/design/2026-08-02-keyvalue-window-shape.md.
 * ================================================================== */

const REF: ValueRef = { kind: 'redisValue', key: 'k' }

/** The smallest well-formed payload of each shape; only `shape` is read here. */
function payload(shape: KeyValueShape): KeyValuePayload {
  switch (shape) {
    case 'scalar':
      return { shape, value: 'v' }
    case 'map':
      return { shape, fields: [] }
    case 'list':
      return { shape, items: [], start: 0 }
    case 'set':
      return { shape, members: [] }
    case 'sortedSet':
      return { shape, entries: [] }
    case 'stream':
      return { shape, entries: [] }
    case 'missing':
      return { shape }
  }
}

/** A cursor of the kind the driver really returns for this shape. */
function cursorFor(shape: KeyValueShape): string {
  switch (shape) {
    case 'map':
    case 'set':
      return '17'
    case 'stream':
      return '(1712000000000-0'
    default:
      return '40'
  }
}

function result(shape: KeyValueShape): KeyValueResult {
  return { ref: REF, type: shape, value: payload(shape), nextCursor: cursorFor(shape) }
}

const PAGEABLE = KEY_VALUE_SHAPES.filter((s) => windowFieldFor(s) !== null)

describe('the next window carries the shape it was derived from', () => {
  for (const shape of PAGEABLE) {
    it(`${shape} declares itself`, () => {
      const window = nextKeyWindow(result(shape), 100)
      assert.ok(window, `${shape} is pageable, so it must produce a window`)
      assert.equal(window.shape, shape)
    })
  }

  it('an unpageable shape still produces no window at all', () => {
    for (const shape of KEY_VALUE_SHAPES.filter((s) => windowFieldFor(s) === null)) {
      assert.equal(nextKeyWindow(result(shape), 100), null)
    }
  })

  it('no cursor means nothing further to read, whatever the shape', () => {
    for (const shape of PAGEABLE) {
      const { nextCursor: _drop, ...noCursor } = result(shape)
      assert.equal(nextKeyWindow(noCursor, 100), null)
    }
  })
})

describe('the boundary validates the window instead of guessing it', () => {
  for (const shape of PAGEABLE) {
    it(`${shape} survives keyValueReadOptions as itself`, () => {
      const window = nextKeyWindow(result(shape), 100)
      assert.ok(window)
      const options = keyValueReadOptions(window)
      // The whole point. Before the shape travelled, a stream's entry id was
      // indistinguishable from a hash cursor and this came back as 'map'.
      assert.equal(options.shape, shape)
      assert.equal(options.limit, 100)
    })
  }

  it('a window addressed the wrong way for its shape is rejected, not reinterpreted', () => {
    // A PeekError is a plain object, not an Error subclass, so it is matched by
    // predicate rather than by message pattern.
    const badRequest = (err: unknown): boolean => isPeekError(err) && err.code === 'BAD_REQUEST'
    assert.throws(
      () => keyValueReadOptions({ shape: 'map', offset: 3 }),
      badRequest,
      'an offset into a hash asks for rows the server will never return',
    )
    assert.throws(() => keyValueReadOptions({ shape: 'list', cursorToken: '17' }), badRequest)
  })
})

describe('the shape is a closed set at the boundary', () => {
  it('accepts every declared shape', () => {
    for (const shape of KEY_VALUE_SHAPES) assert.equal(isKeyValueShape(shape), true)
  })

  it('rejects anything else, because an unknown string would fall through to guessing', () => {
    for (const bad of ['hash', 'zset', '', 'MAP', 42, null, undefined, {}]) {
      assert.equal(isKeyValueShape(bad), false, `${String(bad)} must not pass as a shape`)
    }
  })
})
