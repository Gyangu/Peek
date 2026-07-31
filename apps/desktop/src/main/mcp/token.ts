/**
 * MCP 接入信息落盘：`~/.peek/mcp.json`（文件权限 0600，目录 0700）。
 *
 * token 一旦生成就**复用**——用户执行过
 *   claude mcp add peek --transport http http://127.0.0.1:7332/mcp \
 *     --header "Authorization: Bearer <token>"
 * 之后，重启 peek 不应让配置失效。只有文件缺失/损坏时才重新生成。
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
  /** 写文件时的进程 pid，便于排查是谁在占端口 */
  pid: number
  updatedAt: string
  /** 给用户直接复制的接入命令 */
  hint: string
}

/** token 至少这么长才认为是有效的历史 token */
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

/** 读出历史 token（文件不存在/损坏/token 太短都返回 null） */
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

/** 写入接入信息；目录 0700、文件 0600 */
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
  // mode 只在创建时生效，已存在的文件要显式收紧
  try {
    chmodSync(target, 0o600)
  } catch {
    // Windows 上 chmod 基本无意义，失败不影响功能
  }
  return file
}

/** 常数时间比较 bearer token，避免时序侧信道 */
export function tokenMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) {
    // 长度不同也走一次比较，保持耗时稳定
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
