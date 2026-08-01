/* ==================================================================
 * Reading a `ToolCallRecord` the way a human needs to see it.
 *
 * ## The one thing this file exists for
 *
 * peek runs its own MCP server and hands it to the agent, so the agent can
 * *drive the window the user is looking at* — open a view, run a query, change
 * the layout. When that happens the UI moves on its own, and a chat panel that
 * renders it as one more grey "tool call" row leaves the user watching their
 * workspace rearrange itself with no explanation.
 *
 * So peek's own tools get a distinct treatment: named in plain language, marked
 * as *acting on this window*, and split into the ones that only look
 * (`read_workspace`) and the ones that change what is on screen (`open_view`).
 * Everything here is derived from the tool name and its arguments — nothing is
 * invented, and an unknown tool degrades to its raw name.
 *
 * ## Two shapes that arrive from the wire and must not surprise the view
 *
 * - **Tool names are namespaced.** MCP tools reach the client as
 *   `mcp__<server>__<tool>`; showing that string to a human is noise, so
 *   `parseToolTitle` splits it.
 * - **A single logical call can be two `tool_call`s.** The Claude agent defers
 *   tool schemas behind a `ToolSearch` step, so invoking `read_workspace` emits
 *   a `ToolSearch` call first. It is folded away by default rather than dropped:
 *   hiding it entirely would make the transcript disagree with what the agent
 *   actually did.
 * ================================================================== */

import type { ToolCallRecord } from '@peek/core'

/** peek's own MCP server name, as passed to `session/new`; it fixes the tool prefix. */
export const PEEK_MCP_SERVER = 'peek'

/**
 * peek tools that change what is on screen, as opposed to only reading it.
 *
 * Mirrors `apps/desktop/src/main/mcp/tools/`. A tool missing from this set is
 * treated as read-only, which is the safe default for a *label*: it understates
 * rather than crying wolf, and the tool's own arguments are shown regardless.
 */
const PEEK_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'open_view',
  'activate_view',
  'move_view',
  'set_layout',
  'run_query',
  'connect',
])

/** The agent-side schema loader that wraps deferred tools; see the header. */
export const TOOL_SEARCH_NAME = 'ToolSearch'

export interface ParsedToolTitle {
  /** MCP server that owns the tool, or null for a built-in agent tool. */
  server: string | null
  /** Bare tool name, prefix stripped. */
  tool: string
  /** Whether the tool belongs to peek's own MCP server. */
  isPeek: boolean
  /** True for peek tools that mutate the workspace. */
  mutatesWorkspace: boolean
  /** The agent's deferred-schema lookup step. */
  isToolSearch: boolean
}

const MCP_PREFIX = /^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/

/**
 * Split `mcp__peek__open_view` into its parts.
 *
 * The regex refuses `__` inside the server segment on purpose: a server named
 * `a__b` would make the split ambiguous, and guessing wrong would mislabel a
 * third-party tool as peek's.
 */
export function parseToolTitle(title: string): ParsedToolTitle {
  const m = MCP_PREFIX.exec(title)
  if (!m) {
    return {
      server: null,
      tool: title,
      isPeek: false,
      mutatesWorkspace: false,
      isToolSearch: title === TOOL_SEARCH_NAME,
    }
  }
  const server = m[1] ?? ''
  const tool = m[2] ?? ''
  const isPeek = server === PEEK_MCP_SERVER
  return {
    server,
    tool,
    isPeek,
    mutatesWorkspace: isPeek && PEEK_MUTATING_TOOLS.has(tool),
    isToolSearch: false,
  }
}

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

/**
 * A one-line rendering of the arguments, for the collapsed header.
 *
 * `rawInput` streams in as the model writes its JSON, so this runs against
 * partial objects on most frames and must stay total. Long values are cut here
 * rather than by CSS: the string also feeds `title` attributes and the
 * permission prompt, where an ellipsis in the text is the honest signal.
 */
export function summarizeToolInput(rawInput: unknown, maxLength = 120): string {
  if (rawInput === undefined || rawInput === null) return ''
  if (typeof rawInput === 'string') return clip(rawInput, maxLength)
  if (typeof rawInput !== 'object') return clip(String(rawInput), maxLength)

  if (Array.isArray(rawInput)) return clip(safeJson(rawInput), maxLength)

  const entries = Object.entries(rawInput as Record<string, unknown>)
  if (entries.length === 0) return ''
  const parts = entries.map(([k, v]) => `${k}: ${scalar(v)}`)
  return clip(parts.join('  ·  '), maxLength)
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'object') return safeJson(value)
  return String(value)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    // Cyclic or otherwise unserialisable input is a wire-level oddity, not a
    // reason to blank the row.
    return String(value)
  }
}

/** Pretty-print arguments for the expanded body. */
export function formatToolInput(rawInput: unknown): string {
  if (rawInput === undefined || rawInput === null) return ''
  if (typeof rawInput === 'string') return rawInput
  try {
    return JSON.stringify(rawInput, null, 2) ?? String(rawInput)
  } catch {
    return String(rawInput)
  }
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

/**
 * The text a tool call produced, from whichever field carries it.
 *
 * `content` is what the agent offers for display and is preferred. `rawOutput`
 * is the fallback and is typed `unknown` for a reason recorded in the contract:
 * an MCP tool answers with an **array** of content blocks, and a client that
 * typed it as an object dropped every completion notification on the floor.
 * Both shapes are handled here so neither can go blank.
 */
export function toolResultText(call: ToolCallRecord): string {
  const fromContent = call.content
    .map((c) => (c.type === 'text' ? c.text : diffText(c)))
    .filter((s) => s !== '')
    .join('\n')
  if (fromContent !== '') return fromContent
  return rawOutputText(call.rawOutput)
}

function diffText(c: Extract<ToolCallRecord['content'][number], { type: 'diff' }>): string {
  return `${c.path}\n${c.newText}`
}

/** Flatten `rawOutput`, which may be a string, an MCP content array, or an object. */
export function rawOutputText(rawOutput: unknown): string {
  if (rawOutput === undefined || rawOutput === null) return ''
  if (typeof rawOutput === 'string') return rawOutput
  if (Array.isArray(rawOutput)) {
    const parts = rawOutput.map((item) => {
      if (typeof item === 'string') return item
      if (item !== null && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        if (typeof rec['text'] === 'string') return rec['text']
      }
      return safeJson(item)
    })
    return parts.filter((s) => s !== '').join('\n')
  }
  return safeJson(rawOutput)
}

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

export type PlanStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanEntry {
  content: string
  status: PlanStatus
  priority?: 'high' | 'medium' | 'low'
}

/**
 * Recover a plan from a tool call.
 *
 * ⚠️ Contract gap, recorded rather than papered over: `ChatBlock` has no `plan`
 * variant and `ChatDelta` has no plan event, so ACP's `plan` session update
 * currently has nowhere to land. Meanwhile the agent's own `TodoWrite` tool
 * carries the same information and *does* arrive, as a tool call of kind
 * `think`. This reads both shapes — the todo list that exists today, and an ACP
 * `PlanEntry[]` for the day the contract grows one — so the checklist renders
 * either way and the view needs no change when it does.
 *
 * Returns null when the call is not plan-shaped, which is the overwhelming case.
 */
export function extractPlan(call: ToolCallRecord): PlanEntry[] | null {
  const input = call.rawInput
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const rec = input as Record<string, unknown>
  const list = rec['todos'] ?? rec['entries'] ?? rec['plan']
  if (!Array.isArray(list) || list.length === 0) return null

  const entries: PlanEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const content = item['content'] ?? item['activeForm'] ?? item['title']
    if (typeof content !== 'string') continue
    entries.push({
      content,
      status: asPlanStatus(item['status']),
      ...(asPriority(item['priority']) ? { priority: asPriority(item['priority']) } : {}),
    })
  }
  return entries.length > 0 ? entries : null
}

function asPlanStatus(value: unknown): PlanStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function asPriority(value: unknown): PlanEntry['priority'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined
}
