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
 * execution path however a tool was declared, and now however far away a tool
 * runs: a package's mapping executes in that package's host process, wrapped by
 * the same constructor (`mcp/package-tools.ts`).
 *
 * The duplicate-name check spans both, and that is the interesting half: a
 * package shadowing `run_query` would otherwise be a silent takeover of a kernel
 * tool, and the MCP SDK's `registerTool` would happily accept the second
 * registration.
 */

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toPeekError } from '@peek/core'
import { errorOutput } from './executor'
import { packageTools, type PackageToolCaller } from './package-tools'
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
 * Collect every tool under tools/ automatically — the kernel's own fourteen.
 *
 * eager: true — expanded statically at build time, so it still works once bundled
 * (no reliance on the filesystem at runtime).
 *
 * Still named "builtin" because that is now a meaningful distinction rather than
 * a synonym for "all": these are the kernel's verbs, and a package's tools are
 * every package's, assembled by `packageTools`. `collectTools()` is what anyone
 * serving MCP wants.
 */
export function collectBuiltinTools(): PeekTool[] {
  const modules = import.meta.glob<ToolModule>('./tools/*.ts', { eager: true })
  const tools: PeekTool[] = []

  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path]
    const exported = mod?.default
    if (!isPeekTool(exported)) {
      throw new Error(
        `MCP tool file ${path} must default-export a PeekTool (see executor.defineCommandTool / defineReadTool)`,
      )
    }
    tools.push(exported)
  }
  return tools
}

export interface CollectToolsOptions {
  /**
   * How a package tool reaches its host. Omitted, the tools still list and only
   * calling one fails — see `mcp/package-tools.ts` for why that is the right
   * degradation rather than hiding them.
   */
  callPackageTool?: PackageToolCaller
}

/**
 * The whole tool surface: the kernel's, plus every driver package's.
 *
 * Throws on a duplicate name rather than letting one win. The MCP SDK's
 * `registerTool` would accept both and the last registration would take the
 * name, so a package that declared `run_query` would replace the kernel's — a
 * takeover that produces no error, no log line, and a tool that does something
 * other than what its description says.
 *
 * The second list now comes off disk, so this throw is no longer where that is
 * caught: it would take down the MCP endpoint's `bind`, every new session and
 * the chat host's wiring, none of which can name the package at fault. The
 * refusal moved to `packages/loader.ts`, which compares each manifest against
 * `KERNEL_TOOL_NAMES` and against the packages already accepted, and skips the
 * offender with a report line — the degradation a bad view-kind registration
 * already gets from `registerViewKind`. What is left here is the assertion
 * behind it: reaching this throw means a tool surface was assembled from
 * something the loader never screened.
 */
export function collectTools(options: CollectToolsOptions = {}): PeekTool[] {
  const tools = [...collectBuiltinTools(), ...packageTools(options.callPackageTool ?? null)]
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
export function registerTools(
  server: McpServer,
  tools: readonly PeekTool[],
  ctx: ToolContext,
): RegisteredPeekTool[] {
  const registered: RegisteredPeekTool[] = []
  for (const tool of tools) {
    const handle = server.registerTool(
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
    registered.push({ tool, registered: handle })
  }
  return registered
}

/** One tool as this session registered it, paired with the peek tool it came from. */
export interface RegisteredPeekTool {
  readonly tool: PeekTool
  readonly registered: RegisteredTool
}

/**
 * Re-read every description and write it back into the session's tool table.
 *
 * **Without this, `tools/list_changed` would be a notification about nothing.**
 * Three descriptions are computed from the installed registry — `connect`'s
 * per-driver config examples above all (§4terdecies e) — and they are *lazy on
 * the peek side*: `PeekTool.description` is a getter, so it answers correctly
 * whenever it is read. But `registerTool` reads it **once**, when the session is
 * created, and the SDK stores the string. So a session that was open when a
 * package arrived would keep telling its model that peek cannot connect to it,
 * and re-listing on the notification would return the same stale sentence.
 *
 * The field is assigned rather than put through `RegisteredTool.update`, which
 * does the identical assignment and then sends a `tools/list_changed` of its own
 * — fourteen tools would mean fourteen notifications for one install. The caller
 * sends exactly one afterwards.
 */
export function refreshToolDescriptions(registered: readonly RegisteredPeekTool[]): void {
  for (const entry of registered) entry.registered.description = entry.tool.description
}

/**
 * Bring one live session's tool table in line with a freshly collected set.
 *
 * **This is the half of `tools/list_changed` that makes the notification about
 * something.** `refreshToolDescriptions` above answers the case where the *same*
 * tools describe themselves differently now; this one answers the case where the
 * tools themselves moved, which is what installing or uninstalling a package is.
 * Without it, a session opened before an uninstall goes on offering the gone
 * package's tools for as long as it lives — the first sentence of acceptance 13,
 * measured in §4sedecies(b) and answered by §4duodevicies.
 *
 * Matched by name, because a name is what the session registered under and the
 * only thing a model has to call with. A tool whose name survives keeps its
 * registration rather than being removed and registered again: re-registering
 * would leave the SDK holding a second closure over this session's context for
 * no gain, and refreshing the description is exactly the update that was wanted.
 *
 * The SDK sends a `tools/list_changed` of its own from inside `registerTool` and
 * from `RegisteredTool.remove()`, so swapping a package's tools produces more
 * than one notification. The caller still sends its own afterwards — that is the
 * one covering "nothing was added or removed, but a description moved" — and a
 * client re-listing twice is idempotent.
 */
export function reconcileSessionTools(
  server: McpServer,
  registered: readonly RegisteredPeekTool[],
  tools: readonly PeekTool[],
  ctx: ToolContext,
): RegisteredPeekTool[] {
  const wanted = new Map(tools.map((tool) => [tool.name, tool]))
  const kept: RegisteredPeekTool[] = []

  for (const entry of registered) {
    const replacement = wanted.get(entry.tool.name)
    if (replacement === undefined) {
      entry.registered.remove()
      continue
    }
    // The name is the identity, so the *tool* comes from the new set: a package
    // reinstalled at another version keeps its tool names, and everything else
    // about them may have moved.
    kept.push({ tool: replacement, registered: entry.registered })
    wanted.delete(entry.tool.name)
  }

  // Whatever is left never had a registration in this session.
  kept.push(...registerTools(server, [...wanted.values()], ctx))
  refreshToolDescriptions(kept)
  return kept
}
