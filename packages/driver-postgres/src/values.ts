import {
  VALUE_PREVIEW_BYTES,
  truncatedValue,
  type LogicalType,
  type ValueRef,
} from '@peek/core'

/**
 * 单元格值归一化。
 *
 * 两个职责：
 * 1. 保证放进 ChunkFrame 的值是**结构化克隆安全**的（MessagePort 直传 renderer）。
 *    Buffer 统一转 base64 字符串，避免各端对 Uint8Array 的处理分歧。
 * 2. 超过 VALUE_PREVIEW_BYTES(4KB) 的大值只发预览，标记 TruncatedValue，
 *    全量走 valuePeek（PLAN 第 8 节红线）。
 */

/** 估算一个值在传输时的字节数，用于 adaptiveChunkRows */
export function estimateCellBytes(value: unknown): number {
  if (value === null || value === undefined) return 1
  switch (typeof value) {
    case 'boolean':
      return 1
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'string':
      return Buffer.byteLength(value, 'utf8')
    case 'object':
      break
    default:
      return 8
  }
  if (value instanceof Date) return 24
  if (value instanceof Uint8Array) return value.byteLength
  // TruncatedValue：只算预览部分
  const rec = value as Record<string, unknown>
  const preview = rec['preview']
  if (rec['__peekTruncated'] === true && typeof preview === 'string') {
    return Buffer.byteLength(preview, 'utf8') + 64
  }
  return jsonSize(value)
}

function jsonSize(value: unknown): number {
  const text = safeJson(value)
  return text === null ? 32 : Buffer.byteLength(text, 'utf8')
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** 按字节截断 utf8 文本（可能切断多字节字符，解码时用非严格模式兜住） */
function previewOfText(text: string, limit: number): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= limit) return text
  return new TextDecoder('utf-8').decode(buf.subarray(0, limit))
}

export interface NormalizeContext {
  logical: LogicalType
  /**
   * 被截断时才调用，返回回源定位符。
   * 做成惰性是因为百万行 × 几十列的场景下，为每个单元格预先造一个 ValueRef 对象
   * 光 GC 就能吃掉整个首帧预算。
   */
  makeRef?: () => ValueRef | undefined
  /** 预览上限，默认 VALUE_PREVIEW_BYTES */
  limit?: number
}

function refOf(ctx: NormalizeContext): { ref?: ValueRef } {
  const ref = ctx.makeRef?.()
  return ref === undefined ? {} : { ref }
}

/**
 * 把 pg 解析出来的值转成可直传 renderer 的形态。
 * 返回 TruncatedValue 表示该单元格被截断，前端需要时走 valuePeek 拉全量。
 */
export function normalizeCell(value: unknown, ctx: NormalizeContext): unknown {
  const limit = ctx.limit ?? VALUE_PREVIEW_BYTES
  if (value === null || value === undefined) return null

  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes <= limit) return value
    return truncatedValue(previewOfText(value, limit), 'utf8', {
      byteLength: bytes,
      ...refOf(ctx),
    })
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }

  if (value instanceof Date) return value

  if (value instanceof Uint8Array) {
    const total = value.byteLength
    if (total <= limit) return Buffer.from(value).toString('base64')
    return truncatedValue(Buffer.from(value.subarray(0, limit)).toString('base64'), 'base64', {
      byteLength: total,
      ...refOf(ctx),
    })
  }

  // json / jsonb / 数组 / 复合类型：pg 已解析成 JS 对象
  if (typeof value === 'object') {
    const text = safeJson(value)
    if (text === null) return String(value)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes <= limit) return value
    return truncatedValue(previewOfText(text, limit), 'utf8', {
      byteLength: bytes,
      ...refOf(ctx),
    })
  }

  return String(value)
}
