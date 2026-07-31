/**
 * connect —— 建立一个数据库连接（映射到 conn.open）。
 *
 * 薄壳：inputSchema 直接复用 Command 的 schema，映射就是一条命令。
 */

import { z } from 'zod'
import { commandSchemas } from '@peek/core'
import { defineCommandTool, outcomeData } from '../executor'
import { briefConnection, renderPanelBrief, toJson } from '../summary'

const InputSchema = commandSchemas['conn.open']

/** conn.open 的返回值只需要读这几个字段，用 loose schema 收窄，避免 any */
const ConnOpenResultShape = z.object({
  connId: z.string(),
  treeViewId: z.string().optional(),
})

export default defineCommandTool({
  kind: 'command',
  name: 'connect',
  title: '连接数据库',
  description:
    '连接一个数据库并在 peek 里登记。config 按 driverId 区分：' +
    'postgres/mysql 可只给 url（postgresql://user@host:5432/db）；' +
    'sqlite 给 file；redis 给 url 或 host/port/db；qdrant 给 url(+apiKey)。' +
    'openTree=true 会顺手在界面上开一个命名空间树视图。返回 connId 与实际能力集。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  toCommands(input) {
    return [{ name: 'conn.open', input }]
  },
  render(outcomes, _input, ctx) {
    const parsed = ConnOpenResultShape.safeParse(outcomeData(outcomes, 'conn.open'))
    const snap = ctx.getSnapshot()
    if (!parsed.success) {
      return { text: `连接命令已执行，但返回值不可解析。\n\n${toJson(outcomes)}` }
    }
    const conn = snap.connections.find((c) => String(c.id) === parsed.data.connId)
    const brief = conn ? briefConnection(conn) : null
    const treeNote = parsed.data.treeViewId ? `\n已自动打开命名空间树视图 ${parsed.data.treeViewId}。` : ''
    return {
      text:
        `连接 ${parsed.data.connId} 状态 ${brief?.status ?? '未知'}。${treeNote}\n\n` +
        `${toJson(brief ?? { connId: parsed.data.connId })}\n\n当前面板：\n${renderPanelBrief(snap)}`,
      data: brief,
    }
  },
})
