/**
 * Tool registry.
 *
 * The key to pluggability: every file under `tools/` default-exports one PeekTool (declared
 * with defineCommandTool / defineReadTool), and the registry collects them via
 * import.meta.glob, so **the core never needs to know which tools exist**.
 * Adding a tool means adding a file — this module stays untouched.
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
 * Collect every tool under tools/ automatically.
 * eager: true — expanded statically at build time, so it still works once bundled
 * (no reliance on the filesystem at runtime).
 */
export function collectBuiltinTools(): PeekTool[] {
  const modules = import.meta.glob<ToolModule>('./tools/*.ts', { eager: true })
  const tools: PeekTool[] = []
  const seen = new Set<string>()

  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]
    const exported = mod?.default
    if (!isPeekTool(exported)) {
      throw new Error(`MCP tool file ${path} must default-export a PeekTool (see executor.defineCommandTool / defineReadTool)`)
    }
    if (seen.has(exported.name)) {
      throw new Error(`Duplicate MCP tool name: ${exported.name} (${path})`)
    }
    seen.add(exported.name)
    tools.push(exported)
  }
  return tools
}

/* ================================================================== */
/* Registration on an MCP server                                        */
/* ================================================================== */

/** ToolOutput → MCP CallToolResult. Tool errors always travel via isError, never as protocol exceptions. */
export function toCallToolResult(out: ToolOutput): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: out.text }]
  if (out.data !== undefined) {
    content.push({ type: 'text', text: toJson(out.data) })
  }
  return { content, ...(out.isError === true ? { isError: true } : {}) }
}

/**
 * Register a set of tools on one McpServer instance.
 * There is one McpServer per HTTP session, but the tool definitions are shared (they are stateless).
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
          // Safety net: any escaped exception collapses into a structured error — a single
          // tool must never be able to take the server down.
          ctx.logger.log('error', `Tool ${tool.name} threw an uncaught exception`, err)
          return toCallToolResult(errorOutput(toPeekError(err)))
        }
      },
    )
  }
}
