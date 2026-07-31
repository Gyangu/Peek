import { z } from 'zod'

/**
 * 品牌类型（branded types）。
 * 全部用 zod 的 .brand() 生成，保证 "zod schema 与 TS 类型同源"——
 * 校验器和类型是同一个东西，不存在写两遍走样的可能。
 *
 * 想从裸 string 拿到品牌类型有两条路：
 *   1. 走 schema：`ConnIdSchema.parse(raw)`（外部输入必须走这条）
 *   2. 走构造器：`asConnId(raw)` / `newConnId()`（内部已知安全时用）
 */

export const ConnIdSchema = z.string().min(1).brand<'ConnId'>()
export type ConnId = z.infer<typeof ConnIdSchema>

export const ViewIdSchema = z.string().min(1).brand<'ViewId'>()
export type ViewId = z.infer<typeof ViewIdSchema>

export const PanelIdSchema = z.string().min(1).brand<'PanelId'>()
export type PanelId = z.infer<typeof PanelIdSchema>

/** 平铺树里 split 节点的 id，layout.setRatio 靠它定位 */
export const SplitIdSchema = z.string().min(1).brand<'SplitId'>()
export type SplitId = z.infer<typeof SplitIdSchema>

/** 一次查询/扫描的结果集 id，chunk 流靠它归属 */
export const ResultIdSchema = z.string().min(1).brand<'ResultId'>()
export type ResultId = z.infer<typeof ResultIdSchema>

/* ------------------------------------------------------------------ */
/* 断言式构造器：仅用于内部已知安全的字符串                                 */
/* ------------------------------------------------------------------ */

export const asConnId = (raw: string): ConnId => raw as ConnId
export const asViewId = (raw: string): ViewId => raw as ViewId
export const asPanelId = (raw: string): PanelId => raw as PanelId
export const asSplitId = (raw: string): SplitId => raw as SplitId
export const asResultId = (raw: string): ResultId => raw as ResultId

/* ------------------------------------------------------------------ */
/* id 生成                                                             */
/* ------------------------------------------------------------------ */

let seq = 0

/**
 * 生成带前缀的短 id。进程内单调递增 + 时间戳 + 随机尾巴，
 * 跨进程（main / driver host）也不会撞。
 * 刻意不用 crypto.randomUUID：renderer 在 file:// 下未必是 secure context。
 */
export function makeId(prefix: string): string {
  seq += 1
  const t = Date.now().toString(36)
  const n = seq.toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${t}${n}${r}`
}

export const newConnId = (): ConnId => asConnId(makeId('conn'))
export const newViewId = (): ViewId => asViewId(makeId('view'))
export const newPanelId = (): PanelId => asPanelId(makeId('panel'))
export const newSplitId = (): SplitId => asSplitId(makeId('split'))
export const newResultId = (): ResultId => asResultId(makeId('res'))
/** Command 信封 id，非品牌类型，纯字符串 */
export const newCommandId = (): string => makeId('cmd')
