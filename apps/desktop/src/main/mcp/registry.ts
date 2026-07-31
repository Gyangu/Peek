/**
 * 工具注册表。
 *
 * 可插拔的关键：`tools/` 下每个文件 default-export 一个 PeekTool（用 defineCommandTool /
 * defineReadTool 声明），注册表用 import.meta.glob 自动收集，**内核不需要知道有哪些工具**。
 * 新增一个工具 = 新建一个文件，不碰这里。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toPeekError } from '@peek/core'
import { errorOutput } from './executor'
import { toJson } from './summary'
import type { PeekTool, ToolContext, ToolOutput } from './types'

interface ToolModule {
  default?: unknown
}

function isPeekTool(value: unknown): value is PeekTool {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['name'] === 'string' &&
    typeof v['description'] === 'string' &&
    typeof v['run'] === 'function' &&
    typeof v['inputSchema'] === 'object' &&
    v['inputSchema'] !== null
  )
}

/**
 * 自动收集 tools/ 下的全部工具。
 * eager: true —— 构建期静态展开，打包后依然可用（不依赖运行时文件系统）。
 */
export function collectBuiltinTools(): PeekTool[] {
  const modules = import.meta.glob<ToolModule>('./tools/*.ts', { eager: true })
  const tools: PeekTool[] = []
  const seen = new Set<string>()

  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]
    const exported = mod?.default
    if (!isPeekTool(exported)) {
      throw new Error(`MCP 工具文件 ${path} 必须 default-export 一个 PeekTool（见 executor.defineCommandTool / defineReadTool）`)
    }
    if (seen.has(exported.name)) {
      throw new Error(`MCP 工具名重复：${exported.name}（${path}）`)
    }
    seen.add(exported.name)
    tools.push(exported)
  }
  return tools
}

/* ================================================================== */
/* 注册到 MCP server                                                    */
/* ================================================================== */

/** ToolOutput → MCP 的 CallToolResult。工具错误一律走 isError，不抛协议异常。 */
export function toCallToolResult(out: ToolOutput): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: out.text }]
  if (out.data !== undefined) {
    content.push({ type: 'text', text: toJson(out.data) })
  }
  return { content, ...(out.isError === true ? { isError: true } : {}) }
}

/**
 * 把一组工具注册到一个 McpServer 实例上。
 * 每个 HTTP session 一个 McpServer，但工具定义是共享的（无状态）。
 */
export function registerTools(server: McpServer, tools: readonly PeekTool[], ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const out = await tool.run(args, ctx)
          return toCallToolResult(out)
        } catch (err) {
          // 兜底：任何漏网的异常都收敛成结构化错误，server 绝不因单个工具崩掉
          ctx.logger.log('error', `工具 ${tool.name} 抛出未捕获异常`, err)
          return toCallToolResult(errorOutput(toPeekError(err)))
        }
      },
    )
  }
}
