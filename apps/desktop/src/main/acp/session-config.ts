/**
 * What a `session/new` call needs: a working directory, and the descriptor that
 * points the agent back at peek's own MCP server.
 *
 * The MCP descriptor is **the closed loop**. Without it the chat panel is a
 * chat panel; with it the agent can read the workspace and drive the window
 * through exactly the same Command Bus the human uses.
 */

import { mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PEEK_CONFIG_DIR_NAME, peekError } from '@peek/core'
import type { McpEndpointInfo } from './types'

/**
 * The server name the agent prefixes tools with.
 *
 * Tools arrive as `mcp__<name>__<tool>`, so this string is what turns
 * `read_workspace` into `mcp__peek__read_workspace` in every `tool_call` title.
 * Changing it changes what the UI has to strip and what any documentation must
 * say, so it is a constant rather than a setting.
 */
export const PEEK_MCP_SERVER_NAME = 'peek'

/** Subdirectory of `~/.peek` used as the agent's cwd. */
export const CHAT_WORKDIR_NAME = 'chat'

/**
 * The descriptor handed to `session/new` for peek's MCP endpoint.
 *
 * Structurally an ACP `McpServerHttp`, kept as a local type on purpose: the
 * bearer token flows through this object, and a local declaration makes every
 * place it is constructed or logged easy to find. `headers` is an **array of
 * `{name, value}`**, not an object, and it is required even when empty.
 */
export interface PeekMcpServerDescriptor {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/**
 * Build the descriptor, or return null when peek's MCP server is not listening.
 *
 * Null is a real outcome and callers must handle it loudly. `session/new` does
 * **not** fail when an MCP server is unreachable — it degrades and carries on —
 * so a chat created against a dead endpoint yields an agent that cannot see the
 * window, with nothing anywhere to explain why. peek checks first and says so.
 */
export function buildPeekMcpServer(endpoint: McpEndpointInfo | null): PeekMcpServerDescriptor | null {
  if (!endpoint || !endpoint.url || !endpoint.token) return null
  return {
    type: 'http',
    name: PEEK_MCP_SERVER_NAME,
    url: endpoint.url,
    headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
  }
}

/* The session sandbox — which built-in tools the agent may use, and whether it
 * inherits the user's own configuration — is per-agent, not per-protocol: see
 * `profiles.ts`. Claude Code takes it through `_meta.claudeCode.options`, Codex
 * through its environment. What stays here is what every ACP agent gets the
 * same way: the working directory, and the descriptor pointing back at peek. */


/** `~/.peek/chat`. The parent of every backend's own directory, and where the route index lives. */
export function chatRootDir(configDir?: string): string {
  return join(configDir ?? join(homedir(), PEEK_CONFIG_DIR_NAME), CHAT_WORKDIR_NAME)
}

/**
 * Create and return an agent's working directory.
 *
 * `cwd` is not cosmetic. It is where the agent looks for project-level
 * `CLAUDE.md`, settings and permission rules, and it is the root its own file
 * tools operate from. A directory peek owns keeps a database viewer's chat panel
 * from inheriting an unrelated project's configuration, and keeps the agent's
 * filesystem reach off the user's home directory. The agent rejects a relative
 * path, an empty string and a path that does not exist, so this creates it
 * eagerly.
 *
 * **One directory per agent, not one for all of them.** Each agent writes its
 * session history under its own cwd in its own format, and each reads that
 * directory back through its own `session/list`. Sharing one would have every
 * agent enumerating files written by the others — at best unreadable rows in the
 * catalogue, at worst an agent trying to resume a transcript it cannot parse.
 */
export function ensureChatWorkdir(configDir?: string, agentId?: string): string {
  const root = chatRootDir(configDir)
  const dir = agentId ? join(root, agentId) : root
  let isDirectory: boolean
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    isDirectory = statSync(dir).isDirectory()
  } catch (raw) {
    throw peekError('INTERNAL', `Could not create the chat working directory ${dir}.`, {
      detail: raw instanceof Error ? raw.message : String(raw),
      retryable: false,
    })
  }
  if (!isDirectory) {
    throw peekError('INTERNAL', `The chat working directory ${dir} exists but is not a directory.`, {
      retryable: false,
    })
  }
  return dir
}
