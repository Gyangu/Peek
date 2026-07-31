/**
 * list_connections —— 只读工具：列出当前所有连接及其能力。
 * 直接读 main 的 Workspace Store，不经 Command Bus。
 */

import { z } from 'zod'
import { DRIVER_CAPABILITIES } from '@peek/core'
import { defineReadTool } from '../executor'
import { briefConnection, toJson } from '../summary'

const InputSchema = z.object({
  /** 只看某个状态的连接 */
  status: z.enum(['idle', 'connecting', 'ready', 'error']).optional(),
})

export default defineReadTool({
  kind: 'read',
  name: 'list_connections',
  title: '列出连接',
  description:
    '列出 peek 当前已建立的数据库连接：connId、标签、驱动、状态、实际能力集、脱敏后的连接目标。' +
    '需要 connId 的其他工具（introspect / open_view / run_query）先调这个拿 id。' +
    '返回里还带 driverCapabilities（各驱动连接前的能力预判表）。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  read(input, ctx) {
    const snap = ctx.getSnapshot()
    const conns = snap.connections
      .filter((c) => input.status === undefined || c.status === input.status)
      .map(briefConnection)

    const head =
      conns.length === 0
        ? '当前没有任何连接。用 connect 工具新建一个（例如 postgres：{"config":{"driverId":"postgres","url":"postgresql://user@host:5432/db"}}）。'
        : `共 ${conns.length} 个连接（workspace rev=${snap.rev}）：`

    return {
      text: `${head}\n\n${toJson({ connections: conns, driverCapabilities: DRIVER_CAPABILITIES })}`,
      data: conns,
    }
  },
})
