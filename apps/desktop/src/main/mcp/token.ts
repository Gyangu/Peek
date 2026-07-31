/**
 * Persisting the MCP endpoint details to `~/.peek/mcp.json` (file mode 0600, directory 0700).
 *
 * Once generated, the token is **reused**: after a user has run
 *   claude mcp add peek --transport http http://127.0.0.1:7332/mcp \
 *     --header "Authorization: Bearer <token>"
 * restarting peek must not invalidate their configuration. A new token is minted only when the
 * file is missing or corrupt.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { MCP_CONFIG_FILE_NAME, PEEK_CONFIG_DIR_NAME } from '@peek/core'

export interface McpEndpointFile {
  version: 1
  host: string
  port: number
  path: string
  url: string
  token: string
  /** The pid of the process that wrote the file, so it is easy to tell who holds the port. */
  pid: number
  updatedAt: string
  /** A ready-to-copy command for the user to register the endpoint. */
  hint: string
}

/** Minimum length for a persisted token to be considered valid and reusable. */
const MIN_TOKEN_LEN = 32

export function defaultConfigDir(): string {
  return join(homedir(), PEEK_CONFIG_DIR_NAME)
}

export function configFilePath(configDir: string): string {
  return join(configDir, MCP_CONFIG_FILE_NAME)
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Read back a previously persisted token (returns null if the file is missing, corrupt, or the token is too short). */
export function readExistingToken(configDir: string): string | null {
  try {
    const raw = readFileSync(configFilePath(configDir), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const token = (parsed as Record<string, unknown>)['token']
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LEN) return null
    return token
  } catch {
    return null
  }
}

export interface WriteEndpointInput {
  configDir: string
  host: string
  port: number
  path: string
  token: string
}

/** Write the endpoint details out; directory 0700, file 0600. */
export function writeEndpointFile(input: WriteEndpointInput): McpEndpointFile {
  const url = `http://${input.host}:${input.port}${input.path}`
  const file: McpEndpointFile = {
    version: 1,
    host: input.host,
    port: input.port,
    path: input.path,
    url,
    token: input.token,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    hint: `claude mcp add peek --transport http ${url} --header "Authorization: Bearer ${input.token}"`,
  }

  mkdirSync(input.configDir, { recursive: true, mode: 0o700 })
  const target = configFilePath(input.configDir)
  writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  // `mode` only applies at creation time, so an existing file must be tightened explicitly.
  try {
    chmodSync(target, 0o600)
  } catch {
    // chmod is largely meaningless on Windows; failing here does not break anything.
  }
  return file
}

/** Constant-time bearer token comparison, to avoid a timing side channel. */
export function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) {
    // Still run one comparison even when the lengths differ, to keep the timing stable.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
