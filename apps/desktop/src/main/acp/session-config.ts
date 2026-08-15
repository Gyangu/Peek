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
import type { McpServer } from '@agentclientprotocol/sdk'
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

/**
 * One of the user's own MCP servers, with its credential already unsealed.
 *
 * Deliberately not the settings type. This is what a caller must have *decided*
 * to hand over — main unseals, and nothing downstream of here can reach a
 * keychain — so the plaintext exists in exactly one call's arguments.
 */
export interface UserMcpServer {
  name: string
  transport: 'http' | 'stdio'
  target: string
  args?: string[]
  authHeader?: string
  authValue?: string
}

/**
 * Translate the user's MCP list into ACP descriptors.
 *
 * ## Why these ride as `session/new` parameters, not in Claude Code's `_meta`
 *
 * `_meta.claudeCode.options.mcpServers` stays `{}` and keeps meaning what it
 * means: *drop what this machine happens to have configured* (`profiles.ts`).
 * The agent merges `{...options.mcpServers, ...params.mcpServers}`, so servers
 * sent as parameters arrive alongside peek's own descriptor with the inherited
 * side still emptied — which is the whole distinction this feature rests on. A
 * server the user added in peek's settings is a decision; a server that was
 * already in `~/.claude.json` is a coincidence, and only the first is wanted.
 *
 * Riding on the protocol rather than on one agent's extension also means Codex
 * gets the same list without a second code path.
 *
 * Disabled rows are dropped by the caller, not here — this translates, and a
 * function that also decides is one nobody can test in halves.
 */
export function buildUserMcpServers(servers: readonly UserMcpServer[]): McpServer[] {
  return servers.map((server) => {
    if (server.transport === 'stdio') {
      // `args` and `env` are required by the protocol even when empty.
      return { name: server.name, command: server.target, args: [...(server.args ?? [])], env: [] }
    }
    return {
      type: 'http',
      name: server.name,
      url: server.target,
      // One header or none. The user writes the scheme into the value, so a
      // token that needs `Bearer ` in front of it has it there — peek adding one
      // would break every server that does not want it.
      headers: server.authValue
        ? [{ name: server.authHeader?.trim() || 'Authorization', value: server.authValue }]
        : [],
    }
  })
}


/** `~/.peek/chat`. The parent of every backend's own directory, and where the route index lives. */
export function chatRootDir(configDir?: string): string {
  return join(configDir ?? join(homedir(), PEEK_CONFIG_DIR_NAME), CHAT_WORKDIR_NAME)
}

/**
 * Create and return an agent's working directory.
 *
 * `cwd` is not cosmetic. It is where the agent looks for project-level
 * `CLAUDE.md`, settings and permission rules, and it is the root its own file
 * tools operate from. The agent rejects a relative path, an empty string and a
 * path that does not exist, so this creates it eagerly.
 *
 * **One directory per agent, not one for all of them.** Each agent writes its
 * session history under its own cwd in its own format, and each reads that
 * directory back through its own `session/list`. Sharing one would have every
 * agent enumerating files written by the others — at best unreadable rows in the
 * catalogue, at worst an agent trying to resume a transcript it cannot parse.
 *
 * ## When `chosen` is given, the invariant above becomes the user's problem
 *
 * The default — a directory under `~/.peek/chat` — was doing two jobs, and only
 * one of them survives a user pointing the panel at their own project. It kept
 * the panel from inheriting an unrelated project's configuration, which
 * `settingSources: []` does properly and unconditionally (`profiles.ts`); and it
 * kept the agent's file tools off the user's home directory, which mattered only
 * while there were no file tools. `2026-08-15-chat-panel-full-capability.md`
 * gave the user both — real tools, and somewhere real to point them.
 *
 * So `chosen` is used as given: not created, not nested under anything, not
 * given peek's `0o700`. It is a directory that already existed for its own
 * reasons and this must not touch its permissions. Two agents pointed at one
 * project **will** see each other's session files, which is a consequence of
 * saying "work here" twice and not something to protect anybody from.
 */
export function ensureChatWorkdir(configDir?: string, agentId?: string, chosen?: string): string {
  const dir = chosen ?? (agentId ? join(chatRootDir(configDir), agentId) : chatRootDir(configDir))
  let isDirectory: boolean
  try {
    // Only ever created when peek owns it. A chosen directory that is missing is
    // a wrong setting to report, not a hole to fill: silently creating
    // `~/Projcts/api` because that is what was typed leaves the agent working
    // somewhere the user has never seen.
    if (chosen === undefined) mkdirSync(dir, { recursive: true, mode: 0o700 })
    isDirectory = statSync(dir).isDirectory()
  } catch (raw) {
    throw peekError('INTERNAL', `Could not use the chat working directory ${dir}.`, {
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
