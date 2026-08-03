/**
 * peek's MCP tools, as tools the in-process agent loop can call.
 *
 * ## No HTTP loopback, and why that matters
 *
 * The ACP backend reaches peek the long way round: the agent is a child process,
 * so it calls back over HTTP with a bearer token. That is the only way to talk to
 * something on the other side of a process boundary, and it is what
 * `session-config.ts` builds a descriptor for.
 *
 * The endpoint backend has no such boundary. The MCP server, the Command Bus and
 * this loop are all in main, so the tools are reached by calling them. Three
 * things follow, and all three are improvements rather than shortcuts:
 *
 *  - **No second credential.** Nothing is minted, sent or checked, because
 *    nothing crosses a boundary that would need authenticating.
 *  - **`source: 'agent'` is structural.** It is passed here, in-process, by the
 *    code that built the loop. There is no token to steal and no header to forge:
 *    see `design/2026-08-02-agent-source-and-permission-scope.md` §2.2, whose
 *    guarantee this backend satisfies by construction rather than by sandbox.
 *  - **The tool list is exactly `collectBuiltinTools()`.** Not a subset peek
 *    hopes an agent will respect — the ones that exist are the ones that were
 *    handed over, and there is no mechanism by which a model could ask for
 *    another.
 *
 * ## The permission gate
 *
 * Not here. `beforeToolCall` in `loop.ts` is the gate, and it runs after argument
 * validation and before execution. Putting it in the tool bodies would mean every
 * new tool has to remember to ask; putting it in the loop means none of them can
 * forget.
 */

import { z } from 'zod'
import { Type, type Tool } from '@earendil-works/pi-ai'
import type { CommandSource } from '@peek/core'
import type { PeekTool, ToolContext } from '../../mcp/types'
import { PEEK_MCP_SERVER_NAME } from '../../acp/session-config'

/**
 * The prefix the ACP backends' tools arrive with.
 *
 * Kept for the endpoint backend too, even though nothing here needs a namespace.
 * The transcript UI strips this exact prefix when rendering a tool row, and a
 * conversation should not look different because of which backend answered it.
 */
export const TOOL_PREFIX = `mcp__${PEEK_MCP_SERVER_NAME}__`

export interface EndpointTool extends Tool {
  /** The underlying peek tool, kept so the executor does not have to look it up again. */
  peek: PeekTool
}

/**
 * Wrap every built-in tool for the loop.
 *
 * The JSON Schema comes from the tool's own zod schema through `z.toJSONSchema`,
 * which is the same derivation the MCP server uses — so the model sees the same
 * arguments an external client would, described the same way, and a schema fix
 * lands in both places at once.
 */
export function buildEndpointTools(tools: readonly PeekTool[]): EndpointTool[] {
  return tools.map((tool) => ({
    name: `${TOOL_PREFIX}${tool.name}`,
    description: tool.description,
    parameters: toParameters(tool),
    peek: tool,
  }))
}

/**
 * Execute one tool call.
 *
 * Errors are **returned as text, not thrown**. A tool that fails is a fact the
 * model has to be told so it can try something else; an exception out of here
 * would end the turn and leave the user looking at a stack trace instead of a
 * conversation. `isError` is what the loop turns into a failed tool row.
 */
export async function runEndpointTool(
  tool: EndpointTool,
  args: unknown,
  deps: { ctx: ToolContext; source: CommandSource },
): Promise<{ text: string; isError: boolean; data?: unknown }> {
  const out = await tool.peek.run(args, { ...deps.ctx, source: deps.source })
  const parts = [out.text]
  if (out.data !== undefined) {
    try {
      parts.push(JSON.stringify(out.data, null, 2))
    } catch {
      // A tool whose payload will not serialise still has usable prose above.
    }
  }
  return {
    text: parts.join('\n\n'),
    isError: out.isError === true,
    ...(out.data === undefined ? {} : { data: out.data }),
  }
}

/**
 * A tool's zod schema as JSON Schema.
 *
 * `z.toJSONSchema` is zod 4's own conversion — the same derivation the MCP SDK
 * performs when it registers these tools, so an external client and this loop see
 * the same arguments described the same way.
 *
 * Falls back to an empty object schema rather than throwing: a tool peek cannot
 * describe is still a tool the model should be able to call with no arguments,
 * and dropping it silently would leave the agent unable to see part of the
 * window with nothing anywhere saying why.
 */
function toParameters(tool: PeekTool): Tool['parameters'] {
  try {
    // `io: 'input'` matters: a schema with defaults or transforms describes a
    // different shape going in than coming out, and what the model is being asked
    // to produce is the input side.
    return z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Tool['parameters']
  } catch {
    return Type.Object({})
  }
}
