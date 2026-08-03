/**
 * Tool registry.
 *
 * The key to pluggability: every file under `tools/` default-exports one PeekTool (declared
 * with defineCommandTool / defineReadTool), and the registry collects them via
 * import.meta.glob, so **the core never needs to know which tools exist**.
 * Adding a tool means adding a file — this module stays untouched.
 *
 * ## Two sources, one surface
 *
 * A driver package contributes tools too (design §2.4bis). Those arrive as
 * *specs* from `drivers/mcpTools.ts` rather than as modules under `tools/`, and
 * `collectTools()` is where the two lists become one. They go through the same
 * `defineCommandTool` on the way — see `toPeekTool` — so there is exactly one
 * execution path however a tool was declared.
 *
 * The duplicate-name check spans both, and that is the interesting half: a
 * package shadowing `run_query` would otherwise be a silent takeover of a kernel
 * tool, and the MCP SDK's `registerTool` would happily accept the second
 * registration.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toPeekError } from '@peek/core'
import { DRIVER_TOOL_SPECS } from '../../drivers/mcpTools'
import { errorOutput, toPeekTool } from './executor'
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
 * Collect every tool under tools/ automatically — the kernel's own thirteen.
 *
 * eager: true — expanded statically at build time, so it still works once bundled
 * (no reliance on the filesystem at runtime).
 *
 * Still named "builtin" because that is now a meaningful distinction rather than
 * a synonym for "all": these are the kernel's verbs, and a package's tools are
 * `DRIVER_TOOL_SPECS`. `collectTools()` is what anyone serving MCP wants.
 */
export function collectBuiltinTools(): PeekTool[] {
  const modules = import.meta.glob<ToolModule>('./tools/*.ts', { eager: true })
  const tools: PeekTool[] = []

  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]
    const exported = mod?.default
    if (!isPeekTool(exported)) {
      throw new Error(`MCP tool file ${path} must default-export a PeekTool (see executor.defineCommandTool / defineReadTool)`)
    }
    tools.push(exported)
  }
  return tools
}

/**
 * The whole tool surface: the kernel's, plus every driver package's.
 *
 * Throws on a duplicate name rather than letting one win. The MCP SDK's
 * `registerTool` would accept both and the last registration would take the
 * name, so a package that declared `run_query` would replace the kernel's — a
 * takeover that produces no error, no log line, and a tool that does something
 * other than what its description says. Refusing to start is the only honest
 * answer, and in Phase B it is a build-time mistake by definition: both lists
 * are compiled in.
 *
 * Phase C makes the second list come off disk, and the same throw becomes a
 * *runtime* refusal to load one plugin — at which point it must degrade to
 * skipping that plugin and reporting it, the way a bad view-kind registration
 * already does (`registerViewKind`). That change belongs with the loader, not
 * here, because only the loader knows which plugin to blame.
 */
export function collectTools(): PeekTool[] {
  const tools = [...collectBuiltinTools(), ...DRIVER_TOOL_SPECS.map(toPeekTool)]
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate MCP tool name: ${tool.name}. A driver package may not shadow a kernel tool, ` +
          `nor another package's — see apps/desktop/src/drivers/mcpTools.ts.`,
      )
    }
    seen.add(tool.name)
  }
  return tools
}

/* ================================================================== */
/* Registration on an MCP server                                        */
/* ================================================================== */

/**
 * ToolOutput → MCP CallToolResult. Tool errors always travel via isError, never as
 * protocol exceptions.
 *
 * `uiEffects` becomes a block of its own rather than being folded into `data`,
 * because the two have different owners: `data` is whatever the tool chose to
 * return, `uiEffects` is what the executor observed the window do. Keeping them
 * apart is what lets a client find the second one without knowing which tool it
 * came from — and ACP hands a tool's result blocks through to the chat panel
 * untouched, so this block is the panel's route to a clickable "go to that pane".
 */
export function toCallToolResult(out: ToolOutput): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: out.text }]
  if (out.data !== undefined) {
    content.push({ type: 'text', text: toJson(out.data) })
  }
  if (out.uiEffects !== undefined && out.uiEffects.length > 0) {
    content.push({ type: 'text', text: toJson({ peekUiEffects: out.uiEffects }) })
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
