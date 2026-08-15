import {
  DEFAULT_KEY_VALUE_ELEMENTS,
  MAX_KEY_VALUE_ELEMENTS,
  VALUE_PEEK_MAX_BYTES,
  VALUE_PREVIEW_BYTES,
  peekError,
  peekErrorMsg,
  truncatedValue,
  type ByteRange,
  type KeyValueElement,
  type KeyValuePayload,
  type KeyValueReadOptions,
  type KeyValueResult,
  type KeyValueShape,
  type PeekedValue,
  type ValueRef,
} from '@peek/core'

/**
 * One key → one `KeyValuePayload`.
 *
 * The typed inspector lives or dies on this table: redis's six value types are
 * six unrelated data structures, and the UI renders each with its own inspector.
 * `KeyValueShape` is the driver-independent bucketing the UI switches on;
 * `KeyValueResult.type` keeps the redis name verbatim next to it, because
 * "sortedSet" is what the renderer needs and "zset" is what the user typed.
 */

export const REDIS_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'none'] as const
export type RedisType = (typeof REDIS_TYPES)[number]

/**
 * redis TYPE → the shape the inspector renders.
 *
 * `none` (the key does not exist) maps to `missing` rather than to an error: a
 * key expiring between the SCAN that listed it and the click that opened it is
 * ordinary operation, not a failure, and surfacing it as NOT_FOUND turns a
 * normal race into a red panel.
 */
export const REDIS_TYPE_TO_SHAPE: Readonly<Record<RedisType, KeyValueShape>> = {
  string: 'scalar',
  hash: 'map',
  list: 'list',
  set: 'set',
  zset: 'sortedSet',
  stream: 'stream',
  none: 'missing',
}

export function redisTypeShape(type: string): KeyValueShape {
  return REDIS_TYPE_TO_SHAPE[type as RedisType] ?? 'scalar'
}

/** Is this a redis type this driver knows how to read? */
export function isRedisType(type: string): type is RedisType {
  return (REDIS_TYPES as readonly string[]).includes(type)
}

/**
 * Clamp a caller's window size into the budget core sets.
 * A caller asking for two million hash fields gets MAX_KEY_VALUE_ELEMENTS.
 */
export function clampElements(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_KEY_VALUE_ELEMENTS
  return Math.min(MAX_KEY_VALUE_ELEMENTS, Math.max(1, Math.trunc(limit)))
}

/** Non-negative integer offset, defaulting to 0 */
export function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.trunc(offset))
}

/**
 * Turn one raw element into a `KeyValueElement`, cutting it at
 * `VALUE_PREVIEW_BYTES` and leaving a `ValueRef` behind so valuePeek can fetch
 * the rest.
 *
 * `makeRef` is a thunk for the same reason `normalizeCell` uses one in the
 * PostgreSQL driver: building a ref per element is pure garbage on the 99.9% of
 * elements that fit.
 */
export function keyValueElement(value: string, makeRef?: () => ValueRef | undefined): KeyValueElement {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= VALUE_PREVIEW_BYTES) return value
  const ref = makeRef?.()
  return truncatedValue(previewOfText(value, VALUE_PREVIEW_BYTES), 'utf8', {
    byteLength: bytes,
    ...(ref === undefined ? {} : { ref }),
  })
}

/** Cut utf8 text at a byte boundary; a split multi-byte character is absorbed by non-strict decoding */
function previewOfText(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= limit) return text
  return new TextDecoder('utf-8').decode(buf.subarray(0, limit))
}

/** Address one element inside a key, per the single reading of `path` per type in core's ValueRef */
export function redisElementRef(key: string, db: number | undefined, path: string): ValueRef {
  return { kind: 'redisValue', key, ...(db === undefined ? {} : { db }), path }
}

/**
 * Which redis command reads a window of each shape, and what the window means.
 *
 * The split matters because two different `KeyValueReadOptions` fields drive it:
 *
 * | shape     | command             | window is addressed by      | cursorToken |
 * |-----------|---------------------|-----------------------------|-------------|
 * | scalar    | GET / GETRANGE      | bytes (via valuePeek)       | —           |
 * | map       | HSCAN               | an opaque cursor            | yes         |
 * | set       | SSCAN               | an opaque cursor            | yes         |
 * | list      | LRANGE start stop   | `offset` (an index)         | no          |
 * | sortedSet | ZRANGE … WITHSCORES | `offset` (an index)         | no          |
 * | stream    | XRANGE (start …)    | `offset`, or an entry id    | yes (an id) |
 *
 * A driver must not paper over the difference by faking indices for HSCAN: the
 * cursor is not an offset, and a caller that treats it as one silently skips or
 * repeats fields.
 */
export interface RedisValueDeps {
  /** TYPE, PTTL, OBJECT ENCODING, MEMORY USAGE for one key, pipelined */
  describeKey(
    db: number,
    key: string,
  ): Promise<{
    type: RedisType
    ttlMs: number | null
    encoding: string | null
    bytes: number | null
    size: number | null
  }>
  /** Read one window of the value, dispatched on type */
  readWindow(
    db: number,
    key: string,
    type: RedisType,
    opts: KeyValueReadOptions,
  ): Promise<{ payload: KeyValuePayload; nextCursor?: string; truncated?: boolean }>
  /**
   * Read the single element `path` addresses, keeping the key's own shape.
   *
   * Reading one field of a hash returns a `map` payload holding that one field,
   * not a bare scalar: `KeyValueResult.type` still says `hash`, and a payload
   * whose shape disagreed with the type would make the inspector's exhaustive
   * switch pick the wrong renderer.
   */
  readElement(db: number, key: string, type: RedisType, path: string): Promise<KeyValuePayload | null>
  /** Which db a ref without an explicit `db` means: the one the connection is attached to */
  readonly defaultDb: number
}

/** Narrow a ValueRef to its redis branch; anything else was routed to the wrong driver */
export function requireRedisValueRef(ref: ValueRef): Extract<ValueRef, { kind: 'redisValue' }> {
  if (ref.kind !== 'redisValue') {
    throw peekError('BAD_REQUEST', `The Redis driver does not support ${ref.kind} value references`)
  }
  return ref
}

/**
 * Read one key into a `KeyValueResult`.
 *
 * Elements past `VALUE_PREVIEW_BYTES` travel as a `TruncatedValue` carrying a
 * `redisValue` ref whose `path` addresses that element (see `ValueRef` in core
 * for the one reading of `path` per type) — so the inspector can pull a 10MB
 * hash field on demand without ever having put it in the window.
 */
export async function readKeyValue(
  deps: RedisValueDeps,
  ref: ValueRef,
  opts: KeyValueReadOptions = {},
): Promise<KeyValueResult> {
  const redisRef = requireRedisValueRef(ref)
  const db = redisRef.db ?? deps.defaultDb
  const info = await deps.describeKey(db, redisRef.key)

  // A key that expired between the scan and the click is ordinary operation
  if (info.type === 'none') {
    return { ref, type: 'none', value: { shape: 'missing' } }
  }

  const base: KeyValueResult = {
    ref,
    type: info.type,
    value: { shape: 'missing' },
    ...(info.ttlMs === null ? {} : { ttlMs: info.ttlMs }),
    ...(info.size === null ? {} : { size: info.size }),
    ...(info.bytes === null ? {} : { byteSize: info.bytes }),
    ...(info.encoding === null ? {} : { encoding: info.encoding }),
  }

  if (redisRef.path !== undefined) {
    const payload = await deps.readElement(db, redisRef.key, info.type, redisRef.path)
    if (payload === null) {
      throw peekErrorMsg('NOT_FOUND', 'error.key.pathInvalid', {
        path: redisRef.path,
        type: info.type,
      })
    }
    // One element of a larger structure: `size` still reports the whole key, so
    // `truncated` has to say that what travelled is not all of it.
    return {
      ...base,
      value: payload,
      ...(info.size !== null && info.size > 1 ? { truncated: true } : {}),
    }
  }

  const window = await deps.readWindow(db, redisRef.key, info.type, opts)
  return {
    ...base,
    value: window.payload,
    ...(window.nextCursor === undefined ? {} : { nextCursor: window.nextCursor }),
    ...(window.truncated ? { truncated: true } : {}),
  }
}

/* ================================================================== */
/* valuePeek                                                           */
/* ================================================================== */

export interface RedisPeekDeps {
  describeKey(db: number, key: string): Promise<{ type: RedisType }>
  /**
   * A byte window of a string value, **sliced on the server** with GETRANGE.
   * `total` is STRLEN. This is the whole point of valuePeek for redis: a 200MB
   * string must never be pulled into the driver process just to show 8MB of it.
   */
  readStringRange(
    db: number,
    key: string,
    offset: number,
    length: number,
  ): Promise<{ bytes: Buffer; total: number } | null>
  /**
   * All the bytes of one element inside a container.
   *
   * Redis offers no byte-level slicing inside a hash / list / zset / stream, so
   * this reads the element whole and the window is applied locally. That is
   * acceptable precisely because one element is bounded in a way a whole key is
   * not.
   */
  readElementBytes(db: number, key: string, type: RedisType, path: string): Promise<Buffer | null>
  readonly defaultDb: number
}

function clampPeekRange(range: ByteRange | undefined): { offset: number; length: number } {
  const offset = Math.max(0, Math.trunc(range?.offset ?? 0))
  const wanted = range?.length === undefined ? VALUE_PEEK_MAX_BYTES : Math.trunc(range.length)
  return { offset, length: Math.min(VALUE_PEEK_MAX_BYTES, Math.max(0, wanted)) }
}

/**
 * Is this buffer valid UTF-8?
 *
 * Redis values are byte strings: a serialized protobuf and a JSON document are
 * both perfectly ordinary. Guessing wrong in the utf8 direction corrupts binary
 * data with replacement characters, so the check is a strict round trip.
 */
function isUtf8(buf: Buffer): boolean {
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0
}

function looksLikeJson(text: string): boolean {
  const head = text.trimStart()[0]
  if (head !== '{' && head !== '[') return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Fetch a large value in full, or a byte window of it.
 *
 * `ref.path` decides where the bytes come from, following the one reading of
 * `path` per type that core's `ValueRef` fixes:
 *   absent → the key itself, which only a `string` has (anything else is
 *            `error.key.pathRequired`: "the whole hash" is not a value, it is a
 *            structure, and it is read through getValue's window instead)
 *   present → that one element
 */
export async function peekRedisValue(
  deps: RedisPeekDeps,
  ref: ValueRef,
  range?: ByteRange,
): Promise<PeekedValue> {
  const redisRef = requireRedisValueRef(ref)
  const db = redisRef.db ?? deps.defaultDb
  const { offset, length } = clampPeekRange(range)
  const { type } = await deps.describeKey(db, redisRef.key)

  if (type === 'none') throw peekErrorMsg('NOT_FOUND', 'error.key.notFound', { key: redisRef.key })

  if (redisRef.path === undefined) {
    if (type !== 'string') {
      throw peekErrorMsg('BAD_REQUEST', 'error.key.pathRequired', { type })
    }
    const sliced = await deps.readStringRange(db, redisRef.key, offset, length)
    if (sliced === null) throw peekErrorMsg('NOT_FOUND', 'error.key.notFound', { key: redisRef.key })
    return describeBytes(ref, sliced.bytes, offset, sliced.total)
  }

  const whole = await deps.readElementBytes(db, redisRef.key, type, redisRef.path)
  if (whole === null) {
    throw peekErrorMsg('NOT_FOUND', 'error.key.pathInvalid', { path: redisRef.path, type })
  }
  const part = whole.subarray(offset, offset + length)
  return describeBytes(ref, part, offset, whole.byteLength)
}

/** Pick the encoding and content type for a window of bytes, and decide whether it is the end */
function describeBytes(ref: ValueRef, part: Buffer, offset: number, total: number): PeekedValue {
  const eof = offset + part.byteLength >= total
  if (!isUtf8(part)) {
    return {
      ref,
      encoding: 'base64',
      data: part.toString('base64'),
      byteLength: part.byteLength,
      totalBytes: total,
      contentType: 'application/octet-stream',
      eof,
    }
  }
  const text = part.toString('utf8')
  // Only a complete value can be called JSON: half a document does not parse,
  // and labelling it 'json' would make the inspector try anyway.
  const json = offset === 0 && eof && looksLikeJson(text)
  return {
    ref,
    encoding: json ? 'json' : 'utf8',
    data: text,
    byteLength: part.byteLength,
    totalBytes: total,
    contentType: json ? 'application/json' : 'text/plain',
    eof,
  }
}
