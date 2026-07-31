/**
 * open_view —— 在界面上开一个视图（映射到 view.open）。
 *
 * 五种视图规格由 core 的 ViewOpenSpec 定死：table / query / inspector / tree / vector。
 * 这就是 "AI 说打开 postgres 的 harness 表，界面真的开出来" 的那条路径。
 */

import { z } from 'zod'
import { ResultIdSchema, commandSchemas } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { renderPanelBrief, toJson } from '../summary'
import { waitForResult } from '../wait'

const InputSchema = commandSchemas['view.open'].safeExtend({
  /** 视图开启即取数时，最多等结果多少毫秒再回执（0 = 不等） */
  waitMs: z.number().int().min(0).max(120_000).optional(),
})

const ViewOpenResultShape = z.object({
  viewId: z.string(),
  panelId: z.string(),
  kind: z.string(),
  resultId: ResultIdSchema.optional(),
})

export default defineCommandTool({
  kind: 'command',
  name: 'open_view',
  title: '打开视图',
  description:
    '在 peek 界面上打开一个视图。spec.kind 五选一：' +
    'table（浏览表/keyspace/collection，ref 从 introspect 拿）、' +
    'query（SQL 编辑器，可带 text 并 run=true 直接跑）、' +
    'inspector（看单个大值）、tree（命名空间树）、vector（向量检索）。' +
    '不给 panelId 就开在当前聚焦面板；replace=false 会另开一个面板。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  toCommands(input) {
    const { waitMs: _waitMs, ...cmdInput } = input
    return [{ name: 'view.open', input: cmdInput }]
  },
  async render(outcomes, input, ctx) {
    const parsed = ViewOpenResultShape.safeParse(outcomeData(outcomes, 'view.open'))
    if (!parsed.success) {
      return { text: `view.open 已执行，但返回值不可解析。\n\n${toJson(outcomes)}` }
    }
    const { viewId, panelId, kind, resultId } = parsed.data

    let resultLine = ''
    if (resultId !== undefined) {
      const waitMs = input.waitMs ?? 3000
      const { meta, settled } = waitMs > 0
        ? await waitForResult(ctx, resultId, waitMs)
        : { meta: null, settled: false }
      resultLine = meta
        ? `\n结果集 ${resultId}：${meta.status} · ${meta.rows} 行` +
          `${meta.elapsedMs === undefined ? '' : ` · ${meta.elapsedMs}ms`}` +
          `${meta.error ? ` · ${meta.error.code}: ${meta.error.message}` : ''}`
        : `\n结果集 ${resultId}：仍在加载${settled ? '' : `（等待 ${waitMs}ms 未见终态）`}`
    }

    const snap = ctx.getSnapshot()
    return {
      text:
        `已打开 ${kind} 视图 ${viewId}（面板 ${panelId}）。${resultLine}\n\n` +
        `当前面板：\n${renderPanelBrief(snap)}`,
      data: { viewId, panelId, kind, resultId },
    }
  },
})
