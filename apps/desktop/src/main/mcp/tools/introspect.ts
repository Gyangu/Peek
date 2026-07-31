/**
 * introspect —— 只读工具：展开命名空间树（db → schema → table / key 模式 / collection）。
 *
 * 注意：introspect **不是 Command**（COMMAND_NAMES 里没有它），它是 driver host 的 RPC。
 * 所以这里走 ToolContext.introspect 这条注入的只读通道，与 read_workspace 同类。
 * 拿到 ref 之后用 open_view 把表真正开到界面上。
 */

import { z } from 'zod'
import { ConnIdSchema, peekError, type NamespaceNode } from '@peek/core'
import { defineReadTool, errorOutput } from '../executor'
import { toJson } from '../summary'

const InputSchema = z.object({
  connId: ConnIdSchema,
  /** 要展开的节点 id（NamespaceNode.id）；不给或 null 表示根层 */
  parentId: z.string().nullable().optional(),
  /** 跳过缓存重新拉 */
  refresh: z.boolean().optional(),
  /** 递归展开几层（1 = 只列直接子节点），最多 3 层 */
  depth: z.number().int().min(1).max(3).optional(),
  /** 最多返回多少个节点，防止大库把上下文撑爆 */
  maxNodes: z.number().int().min(1).max(2000).optional(),
})

interface NodeBrief {
  id: string
  name: string
  kind: string
  hasChildren: boolean
  detail?: string
  /** 有 ref 的节点可以直接 open_view 成 table 视图 */
  ref?: NamespaceNode['ref']
  children?: NodeBrief[]
}

function briefNode(n: NamespaceNode): NodeBrief {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    hasChildren: n.hasChildren,
    ...(n.detail === undefined ? {} : { detail: n.detail }),
    ...(n.ref === undefined ? {} : { ref: n.ref }),
  }
}

function outline(nodes: readonly NodeBrief[], indent = ''): string {
  const lines: string[] = []
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1
    const openable = n.ref ? ' (可 open_view)' : ''
    const detail = n.detail ? ` — ${n.detail}` : ''
    lines.push(`${indent}${last ? '└─ ' : '├─ '}${n.kind} ${n.name} [${n.id}]${openable}${detail}`)
    if (n.children && n.children.length > 0) {
      lines.push(outline(n.children, `${indent}${last ? '   ' : '│  '}`))
    }
  })
  return lines.join('\n')
}

export default defineReadTool({
  kind: 'read',
  name: 'introspect',
  title: '浏览命名空间',
  description:
    '懒加载地展开某个连接的命名空间树：不给 parentId 拿根层（PG 是 schema 列表），' +
    '给 parentId 拿它的子节点（如某 schema 下的表）。depth 可一次展开多层（最多 3）。' +
    '返回的节点若带 ref，可直接丢给 open_view 的 spec.ref 把表开到界面上。',
  inputSchema: InputSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async read(input, ctx) {
    if (!ctx.introspect) {
      return errorOutput(
        peekError('INTERNAL', 'introspect 通道未接线', {
          detail: '创建 MCP server 时未注入 introspect（Connection Manager → driver host RPC）。',
        }),
      )
    }

    const snap = ctx.getSnapshot()
    const conn = snap.connections.find((c) => c.id === input.connId)
    if (!conn) {
      return errorOutput(
        peekError('NOT_FOUND', `连接 ${input.connId} 不存在`, {
          detail: '先用 list_connections 看有哪些连接，或用 connect 新建。',
        }),
      )
    }
    if (conn.status !== 'ready') {
      return errorOutput(
        peekError('CONFLICT', `连接 ${conn.label} 当前状态为 ${conn.status}，无法 introspect`),
      )
    }
    if (!conn.capabilities.includes('introspect')) {
      return errorOutput(
        peekError('UNSUPPORTED_CAPABILITY', `驱动 ${conn.driverId} 不支持 introspect`),
      )
    }

    const maxNodes = input.maxNodes ?? 500
    const depth = input.depth ?? 1
    const read = ctx.introspect
    let total = 0
    let capped = false

    const expand = async (parentId: string | null, level: number): Promise<NodeBrief[]> => {
      if (total >= maxNodes) {
        capped = true
        return []
      }
      const nodes = await read({
        connId: input.connId,
        parentId,
        ...(input.refresh === undefined ? {} : { refresh: input.refresh }),
      })
      const out: NodeBrief[] = []
      for (const n of nodes) {
        if (total >= maxNodes) {
          capped = true
          break
        }
        total += 1
        const brief = briefNode(n)
        if (level < depth && n.hasChildren) {
          const children = await expand(n.id, level + 1)
          if (children.length > 0) brief.children = children
        }
        out.push(brief)
      }
      return out
    }

    const root = input.parentId ?? null
    const nodes = await expand(root, 1)

    const head =
      nodes.length === 0
        ? `${conn.label} 的 ${root === null ? '根层' : root} 下没有子节点。`
        : `${conn.label} 的 ${root === null ? '根层' : root} 下共 ${total} 个节点${capped ? `（已截断到 maxNodes=${maxNodes}）` : ''}：`

    return {
      text: `${head}\n${outline(nodes)}\n\n${toJson({ connId: String(input.connId), parentId: root, nodes })}`,
      data: nodes,
    }
  },
})
