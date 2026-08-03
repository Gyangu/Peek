/**
 * Keeping secrets out of everything that leaves a backend, and making one line
 * of agent output safe to display and to log.
 *
 * The agent — a child process speaking ACP, or an LLM endpoint reached over
 * HTTP — is **untrusted input** either way, so every string that reaches a log,
 * a toast or a Workspace field passes through `redact` and `sanitizeLine` first.
 *
 * Backend-agnostic on purpose: the ACP host's error *classification* keys off
 * JSON-RPC codes and lives in `agent/acp/errors.ts`, but redaction applies to
 * every backend. The endpoint backend has its own secret to keep out of logs —
 * the user's API key — and it uses exactly these functions to do it.
 */

import { ConnectionConfigSchema, REDACTED, redactConnectionConfig } from '@peek/core'

/**
 * Replace every occurrence of each secret with `***`.
 *
 * The MCP bearer token is handed to the agent in a `session/new` parameter, and
 * agent stderr echoes its own configuration on some paths. Any log line, error
 * detail or notification built from agent output goes through here first, and
 * short strings are ignored so an accidental empty secret cannot blank the text.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 8) continue
    out = out.split(secret).join('***')
  }
  return out
}

/**
 * Make one line of agent output safe to display and to log.
 *
 * Strips C0/C1 control characters (ANSI escapes, carriage-return overwrites and
 * the like — an untrusted process should not get to rewrite peek's terminal or
 * smuggle invisible content into a Workspace field) and caps the length.
 */
export function sanitizeLine(text: string, maxLen = 400): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const stripped = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim()
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)}…` : stripped
}

/* ------------------------------------------------------------------ */
/* Credentials inside a tool's arguments                               */
/* ------------------------------------------------------------------ */

/**
 * `scheme://user:password@host`, masked everywhere it occurs.
 *
 * Core's `redactUrlCredentials` does the same job but replaces only the first
 * match, which is exactly right for a config field holding one URL. A tool
 * argument is free-form — a single shell command can name two DSNs — so the sweep
 * here is global, and it stops at whitespace so a bare `@` later in a sentence
 * cannot drag the match across half the line.
 */
const URL_CREDENTIALS_RE = /(:\/\/[^:/@\s]*):[^@\s]*@/g

function maskUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS_RE, `$1:${REDACTED}@`)
}

/**
 * Argument names whose **value** is a credential, whatever tool they belong to.
 *
 * The fallback for tools peek knows nothing about — a config shape it can parse
 * is handled precisely, one field below. Deliberately anchored whole-name
 * matches: `password` is a secret, `passwordPolicy` is not, and over-masking a
 * permission prompt costs the user the ability to see what they are approving.
 * `url` is **not** in this list: masking a whole URL would hide the host the user
 * is being asked to allow, so URLs keep their shape and lose only the password.
 */
const SECRET_KEY_RE =
  /^(?:password|passwd|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|auth[-_]?token|authorization|bearer|credential|credentials|private[-_]?key|session[-_]?token|client[-_]?secret)$/i

/** Deep enough for any real tool payload; a guard against a pathological nest, not a policy. */
const MAX_PREVIEW_DEPTH = 8

/**
 * Walk a tool argument, masking secret-named fields and credentials in strings.
 *
 * The cycle guard is scoped to the current path (added on the way down, removed
 * on the way up), so a value that legitimately appears twice is still rendered
 * twice — only a real loop becomes a marker.
 */
function redactPreviewValue(value: unknown, depth: number, path: Set<object>): unknown {
  if (typeof value === 'string') return maskUrlCredentials(value)
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_PREVIEW_DEPTH) return '…'
  if (path.has(value)) return '[circular]'
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => redactPreviewValue(item, depth + 1, path))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactPreviewValue(item, depth + 1, path)
    }
    return out
  } finally {
    path.delete(value)
  }
}

/**
 * Strip credentials out of a tool's raw arguments.
 *
 * ## Why this exists at all
 *
 * The preview built from these arguments is not a local string. It becomes
 * `PendingPermission.inputPreview`, which is Workspace state: `summarizeChat`
 * carries it into the outward snapshot that `read_workspace` hands to any MCP
 * caller holding the bearer token, and the same field is broadcast to the
 * renderer, for as long as the prompt stands. A cleartext DSN there is a secret
 * published to a wider audience than the one that typed it — and the same field
 * is already redacted on the way to the command log (`redactCommandInput`), so
 * leaving this path open was a hole in an otherwise closed surface.
 *
 * ## Two passes, because they know different amounts
 *
 * The generic walk knows nothing about peek and masks by field name. The second
 * pass is exact: `connect`'s `config` is a shape core can parse, so it goes
 * through the same `redactConnectionConfig` every other outbound copy of a config
 * uses — which also drops any key the schema does not declare.
 */
export function redactToolInput(rawInput: unknown): unknown {
  if (typeof rawInput === 'string') return maskUrlCredentials(rawInput)
  if (typeof rawInput !== 'object' || rawInput === null) return rawInput

  const walked = redactPreviewValue(rawInput, 0, new Set<object>())
  if (Array.isArray(walked) || typeof walked !== 'object' || walked === null) return walked

  // Parsed from the *original* input: the walk has already masked the password,
  // and a schema is stricter about everything else.
  const parsed = ConnectionConfigSchema.safeParse((rawInput as Record<string, unknown>)['config'])
  if (parsed.success) (walked as Record<string, unknown>)['config'] = redactConnectionConfig(parsed.data)
  return walked
}

/**
 * A short, safe rendering of a tool's arguments, for a permission prompt.
 *
 * Never the full input: it can be arbitrarily large, it is untrusted, and a
 * permission dialog that scrolls is a permission dialog nobody reads. Never the
 * *raw* input either — see {@link redactToolInput}. The final sweep repeats the
 * URL mask on the serialised form, which is what covers a payload the structural
 * walk could not enter (a string of pre-serialised JSON, anything past the depth
 * limit).
 */
export function previewInput(rawInput: unknown, maxLen = 300): string {
  const safe = redactToolInput(rawInput)
  let text: string
  try {
    text = typeof safe === 'string' ? safe : JSON.stringify(safe)
  } catch {
    text = String(safe)
  }
  if (text === undefined || text === 'undefined') return ''
  return sanitizeLine(maskUrlCredentials(text), maxLen)
}
