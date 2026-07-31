/**
 * run_query —— 执行一条自由查询（映射到 query.run）。
 *
 * 返回给 AI 的是**截断后的前 N 行 + 总行数**，完整数据留在界面里（PLAN 第 8 节）。
 * 行数据本身走 MessagePort 直达 renderer，main 手里没有；所以取样行依赖注入的
 * readResultRows。没注入时退化成只回结果集元信息（状态/行数/耗时）。
 */

import { z } from 'zod'
import {
  MCP_DEFAULT_MAX_ROWS,
  ResultIdSchema,
  ViewIdSchema,
  commandSchemas,
  peekError,
} from '@peek/core'
import { defineCommandTool, errorOutput, outcomeData } from '../executor'
import { toJson } from '../summary'
import { renderRowsTable, waitForResult } from '../wait'
import type { ResultRowsSlice } from '../types'

/** 默认给 AI 看多少行 */
const DEFAULT_PREVIEW_ROWS = 20
/** 默认等待查询终态的时长 */
const DEFAULT_WAIT_MS = 30_000

const InputSchema = commandSchemas['query.run'].safeExtend({
  /** 回执里最多展示多少行（不影响界面，界面拿全量） */
  previewRows: z.number().int().min(0).max(200).optional(),
  /** 最多等多久（毫秒）拿终态；超时不代表查询失败，界面会继续跑 */
  waitMs: z.number().int().min(0).max(120_000).optional(),
})

const QueryRunResultShape = z.object({
  resultId: ResultIdSchema,
  viewId: ViewIdSchema,
})

export default defineCommandTool({
  kind: 'command',
  name: 'run_query',
  title: '执行查询',
  description:
    '在某个连接上执行一条查询语句（SQL 等）并把结果显示在 peek 的 query 视图里。' +
    '给 connId + text 会自动新开一个 query 视图；给已有 query 视图的 viewId 则在原视图里跑。' +
    '回执只带前 previewRows 行（默认 20）与总行数，完整结果在界面上看。' +
    `不给 maxRows 时服务端按 ${MCP_DEFAULT_MAX_ROWS} 行封顶并标记已截断——` +
    '要更多请显式给 maxRows，并注意界面视口不推进时流会进入 paused（数据仍有效）。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  toCommands(input) {
    const { previewRows: _p, waitMs: _w, ...cmdInput } = input
    return [
      {
        name: 'query.run',
        // 服务端默认上限：没说要多少行 ⇒ 给前 MCP_DEFAULT_MAX_ROWS 行 + truncated。
        // 否则一条 select * 打在大表上必然走进背压暂停路径（无头调用没有真实视口在推进）。
        input: { ...cmdInput, maxRows: cmdInput.maxRows ?? MCP_DEFAULT_MAX_ROWS },
      },
    ]
  },
  async render(outcomes, input, ctx) {
    const parsed = QueryRunResultShape.safeParse(outcomeData(outcomes, 'query.run'))
    if (!parsed.success) {
      return errorOutput(
        peekError('INTERNAL', 'query.run 返回值不可解析', { detail: toJson(outcomes) }),
      )
    }
    const { resultId, viewId } = parsed.data
    const waitMs = input.waitMs ?? DEFAULT_WAIT_MS
    const previewRows = input.previewRows ?? DEFAULT_PREVIEW_ROWS
    const maxRows = input.maxRows ?? MCP_DEFAULT_MAX_ROWS

    const { meta, settled } = await waitForResult(ctx, resultId, waitMs)

    const headBits = [`查询已在视图 ${viewId} 执行，结果集 ${resultId}`]
    if (meta) {
      headBits.push(`状态 ${meta.status}`)
      headBits.push(`${meta.rows} 行`)
      if (meta.elapsedMs !== undefined) headBits.push(`${meta.elapsedMs}ms`)
      if (meta.truncated) {
        headBits.push(
          meta.status === 'paused'
            ? '已截断（背压暂停）'
            : `已按 maxRows=${maxRows} 截断`,
        )
      }
    } else {
      headBits.push('尚未拿到结果集元信息')
    }
    if (!settled) headBits.push(`等待 ${waitMs}ms 未见终态，界面仍在加载`)

    /* --- 真失败：唯一置 isError 的分支 --- */
    if (meta?.status === 'error' && meta.error) {
      return {
        text: `${headBits.join(' · ')}\n\n[${meta.error.code}] ${meta.error.message}` +
          `${meta.error.detail ? `\n${meta.error.detail}` : ''}`,
        data: meta.error,
        isError: true,
      }
    }

    /*
     * paused / cancelled 都**不是** isError：查询本身没问题，已加载的行全部有效。
     * 这句提示是 AI 区分「查询挂了」和「只是停下来了」的唯一依据，措辞不要弱化。
     */
    let notice = ''
    if (meta?.status === 'paused') {
      notice =
        `\n\n⏸ 已暂停（不是失败）：${meta.pausedReason ?? '背压空闲超时'}。`
        + `已加载的 ${meta.rows} 行是完整有效的数据，可以直接使用；`
        + '后面还有更多行没取。要继续请重新执行（可配合更大的 maxRows，'
        + '或在界面上把表格滚到底部再跑）。'
    } else if (meta?.status === 'cancelled') {
      notice = '\n\n■ 已取消（不是失败）：已加载的行有效，后面的数据没有取。'
    }

    let table = ''
    let slice: ResultRowsSlice | null = null
    if (previewRows > 0 && ctx.readResultRows && meta && meta.rows > 0) {
      try {
        slice = await ctx.readResultRows({ resultId, limit: previewRows })
        table = `\n\n前 ${slice.rows.length} 行（共 ${slice.totalRows} 行${slice.truncated ? '，已截断' : ''}）：\n${renderRowsTable(slice)}`
      } catch (err) {
        ctx.logger.log('warn', 'readResultRows 失败', err)
        table = '\n\n（取样行失败，完整结果请在界面查看）'
      }
    } else if (previewRows > 0 && !ctx.readResultRows) {
      table = '\n\n（未接线 readResultRows：行数据只在界面缓存里，这里只能给元信息）'
    }

    const columns = meta?.schema?.map((c) => `${c.name}:${c.logical}`).join(', ') ?? ''
    return {
      text: `${headBits.join(' · ')}${columns ? `\n列：${columns}` : ''}${notice}${table}`,
      data: {
        resultId: String(resultId),
        viewId: String(viewId),
        status: meta?.status ?? 'running',
        rows: meta?.rows ?? 0,
        /** 数据是否可信：只有 error 为 false，paused/cancelled 都是 true */
        rowsUsable: meta?.status !== 'error',
        truncated: meta?.truncated === true,
        resumable: meta?.resumable === true,
        maxRows,
        preview: slice?.rows ?? [],
      },
    }
  },
})
