import type { ResultId } from './ids'
import type { PeekError } from './errors'
// 注意：这里是"仅类型"的循环引用（chunk ↔ capability），编译后完全擦除，无运行时循环。
import type { ValueRef } from './capability'

export type { ResultId } from './ids'

/* ------------------------------------------------------------------ */
/* 列定义                                                              */
/* ------------------------------------------------------------------ */

/**
 * 逻辑类型：跨驱动统一的一层薄归类，只用来决定渲染方式
 * （右对齐？等宽？折叠 JSON？走 valuePeek？），不承担语义精度。
 * 需要精确类型时看 nativeType。
 */
export type LogicalType =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'time'
  | 'timestamp'
  | 'interval'
  | 'json'
  | 'bytes'
  | 'uuid'
  | 'array'
  | 'vector'
  | 'geo'
  | 'unknown'

export interface ColumnDef {
  /** 列名（结果集内唯一；驱动遇到重名需自行去重，如 name, name__2） */
  name: string
  /** 渲染用的逻辑类型 */
  logical: LogicalType
  /** 驱动原始类型名，如 pg 的 'int8' / 'jsonb' / 'timestamptz' */
  nativeType: string
  nullable?: boolean
  /** 该列可能出现被截断的大值（前端提前准备 valuePeek 入口） */
  peekable?: boolean
  /** 主键列（collectionScan 时驱动可给出，前端用来做行定位） */
  primaryKey?: boolean
}

/* ------------------------------------------------------------------ */
/* chunk 帧（列式）                                                     */
/* ------------------------------------------------------------------ */

export interface ChunkDone {
  /** 本结果集累计行数 */
  rows: number
  /** 从发起到收尾的总耗时（毫秒），由 driver host 计时 */
  elapsedMs: number
  /** 因 maxRows 上限被截断（还有更多数据没取） */
  truncated?: boolean
  /** 续拉游标（redis SCAN cursor / qdrant next_page_offset）；有值表示可继续 */
  nextCursor?: string
}

/**
 * 结果流的一帧。**列式**存储，为将来换 Arrow / ArrayBuffer 留位。
 *
 * 约定（实现者必须遵守）：
 * - `schema` 只在 seq === 0 的首帧出现，之后的帧不再重复。
 * - `cols.length === schema.length`，每个 `cols[i].length === rowCount`。
 * - 最后一帧带 `done`。**结果集的正常终止有且只有这一种信号**——
 *   空结果集也要发一帧（cols 为各列的空数组、rowCount 为 0、带 done）。
 * - 异常终止走 `ResultStreamMessage` 的 error 分支，此时不会再有带 done 的帧。
 * - seq 从 0 开始连续递增，接收端据此检测丢帧。
 */
export interface ChunkFrame {
  resultId: ResultId
  seq: number
  /** 仅首帧携带 */
  schema?: ColumnDef[]
  /** 按列存：cols[列下标][行下标] */
  cols: unknown[][]
  /** 本帧行数（cols 可能为空数组，所以行数必须显式给） */
  rowCount: number
  /** 仅末帧携带 */
  done?: ChunkDone
}

/* ------------------------------------------------------------------ */
/* 大值截断                                                            */
/* ------------------------------------------------------------------ */

/** 截断标记的判别字段名，值必须是字面量 true */
export const TRUNCATED_MARKER = '__peekTruncated' as const

/**
 * 单元格里放不下的大值（长文本 / bytea / 向量本体）在 chunk 里以此形态出现。
 * 驱动负责只发预览，全量走 valuePeek 按需拉。
 */
export interface TruncatedValue {
  readonly __peekTruncated: true
  /** 预览内容，已按 VALUE_PREVIEW_BYTES 截断 */
  preview: string
  /** preview 的编码方式；bytes 类走 base64 */
  encoding: 'utf8' | 'base64'
  /** 原始值的完整字节长度（可知时） */
  byteLength?: number
  /** 拉全量用的定位符 */
  ref?: ValueRef
}

export function isTruncatedValue(value: unknown): value is TruncatedValue {
  return typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>)[TRUNCATED_MARKER] === true
}

export function truncatedValue(
  preview: string,
  encoding: TruncatedValue['encoding'],
  extra?: Pick<TruncatedValue, 'byteLength' | 'ref'>,
): TruncatedValue {
  return { __peekTruncated: true, preview, encoding, ...extra }
}

/* ------------------------------------------------------------------ */
/* 结果流消息（driver host ──MessagePort──► renderer）                   */
/* ------------------------------------------------------------------ */

/**
 * 结果流**按设计暂停**的描述。
 *
 * 与 error 的区别是硬性的语义边界：
 * - error  = 这次执行失败了，已拿到的数据不完整且可能不可信；
 * - paused = 执行本身没有任何问题，只是背压把它停住了（视口不动 / 缓存到顶），
 *   服务端游标与连接已被主动释放。**已加载的行全部有效**，重跑即可继续取数。
 *
 * 之所以要单独一种消息而不是复用 error：AI 通过 MCP 拿到回执时必须能分清
 * 「查询挂了」和「只是停下来了、已加载的 90 万行是好的」。
 */
export interface ResultPause {
  /** 暂停时已发出的累计行数 */
  rows: number
  /** 从发起到暂停的耗时（毫秒） */
  elapsedMs: number
  /** 暂停原因；目前只有"空闲 ack 超时" */
  reason: 'idleAck'
  /** 人可读说明 */
  message: string
  /** 恒为 true：重新执行即可从头继续取数（PG 侧游标已关，不能断点续传） */
  resumable: true
}

/** host → renderer：数据面。控制面（状态机变更）另走 main。 */
export type ResultStreamMessage =
  | { t: 'chunk'; frame: ChunkFrame }
  | { t: 'error'; resultId: ResultId; error: PeekError }
  /** 背压把流停住了：这不是错误，已收到的行完全有效 */
  | { t: 'paused'; resultId: ResultId; paused: ResultPause }

/** renderer → host：背压与取消。 */
export type ResultStreamAck =
  /** 确认已消费到 seq（含），host 据此推进 ack 窗口 */
  | { t: 'ack'; resultId: ResultId; seq: number }
  /** 主动取消，host 关游标 */
  | { t: 'cancel'; resultId: ResultId }

/* ------------------------------------------------------------------ */
/* 性能预算常量（PLAN 第 8 节，红线）                                     */
/* ------------------------------------------------------------------ */

/** 背压 ack 窗口：未确认 chunk 数达到这个值就暂停拉取 */
export const ACK_WINDOW = 4

/** chunk 目标字节尺寸下限 256KB */
export const CHUNK_TARGET_BYTES_MIN = 256 * 1024
/** chunk 目标字节尺寸上限 1MB */
export const CHUNK_TARGET_BYTES_MAX = 1024 * 1024
/** chunk 目标行数下限 */
export const CHUNK_TARGET_ROWS_MIN = 500
/** chunk 目标行数上限 */
export const CHUNK_TARGET_ROWS_MAX = 2000
/** 尚未量出行宽时的起手行数 */
export const CHUNK_DEFAULT_ROWS = 1000

/** 单个大 value 的预览截断长度：4KB */
export const VALUE_PREVIEW_BYTES = 4 * 1024

/** renderer 结果缓存上限 ~200MB，超了按 LRU 淘汰远端 chunk */
export const RESULT_CACHE_MAX_BYTES = 200 * 1024 * 1024

/** valuePeek 单次拉取的最大字节数，避免一次性拉爆内存 */
export const VALUE_PEEK_MAX_BYTES = 8 * 1024 * 1024

/**
 * MCP 侧 `run_query` 在调用方没给 maxRows 时的服务端默认上限。
 *
 * 没有这道闸，AI 一条 `select *` 打在千万行表上就必然走进背压暂停路径
 * （视口只覆盖几十行，前方永远堆着几十万行未消费）。给一个明确的默认值 +
 * `truncated: true`，让"没说要多少行"退化成"给你前 20 万行，还有更多"。
 * 人在界面上手动执行不受此限（那条路径有真实视口在推进）。
 */
export const MCP_DEFAULT_MAX_ROWS = 200_000

/** collectionScan / 表格视图的默认分页大小 */
export const DEFAULT_PAGE_LIMIT = 200
/** 单次请求允许的最大 limit */
export const MAX_PAGE_LIMIT = 100_000

/**
 * 根据已观测到的平均行字节数，算出下一批该取多少行。
 * 驱动实现统一调这个函数，保证四个库的 chunk 尺寸行为一致。
 */
export function adaptiveChunkRows(avgRowBytes: number): number {
  if (!Number.isFinite(avgRowBytes) || avgRowBytes <= 0) return CHUNK_DEFAULT_ROWS
  const target = Math.floor(CHUNK_TARGET_BYTES_MAX / avgRowBytes)
  return Math.min(CHUNK_TARGET_ROWS_MAX, Math.max(CHUNK_TARGET_ROWS_MIN, target))
}
