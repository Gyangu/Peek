/**
 * The last thing a diagnostic line passes through before it is on disk.
 *
 * ## Why this is a backstop and not a guarantee — say it out loud
 *
 * The audit stream has a schema, so it is redacted **by name**
 * (`redactCommandInput`: a `conn.open` config never reaches the log at all).
 * The diagnostic stream has no schema — it is free text from four subsystems and
 * a child process — so all that is possible here is pattern matching, and a
 * pattern matcher cannot stop a shape it has never seen.
 *
 * This is written down because the failure mode is people trusting it. PLAN §7
 * ("the token does not go into logs") is enforced at the *call sites* — the MCP
 * token is never passed to a log call in the first place — and this file exists
 * to catch the accident, not to license the practice.
 *
 * ## Why it reuses `agent/redact.ts`
 *
 * That module already solved the hard half: `redact` masks known literal secrets
 * (peek hands the MCP bearer token to the agent, and agent stderr echoes its own
 * configuration on some paths), and `maskUrlCredentials` strips
 * `scheme://user:pass@host`. Both apply verbatim to a log line. What is added
 * here is the three shapes a *log* line carries that an agent string does not.
 */

import { maskUrlCredentials, redact } from '../agent/redact'

/**
 * `Authorization: Bearer abc…`, in a header dump or a curl echo.
 *
 * The value is taken to the end of the line rather than to the next space: a
 * header value can contain spaces, and leaving the tail of a token behind is
 * the same as leaving the token behind.
 */
const AUTH_HEADER_RE = /\b(authorization|proxy-authorization)\s*[:=]\s*.*/gi

/** A bare `Bearer <token>` with no header name in front of it. */
const BEARER_RE = /\bbearer\s+[\w\-._~+/]{8,}=*/gi

/**
 * `password=…`, `"api_key": "…"`, `token: …` — the assignment shapes.
 *
 * Stops at the first delimiter (quote, comma, brace, whitespace) because unlike
 * the header case these appear *inside* structures, and swallowing to the end of
 * the line would redact the JSON that follows.
 *
 * The closing quote of the **key** belongs to the separator group, not to the
 * name. In JSON the character after `password` is `"`, not `:` — without this
 * the most common shape a secret actually travels in (`"password": "…"`) sailed
 * straight through, which is precisely what `scrub.test.ts` caught.
 */
const ASSIGNED_SECRET_RE =
  /\b(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|auth)\b("?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]&]+)/gi

export interface Scrubber {
  /**
   * Register a literal secret — the MCP bearer token, an endpoint API key.
   *
   * Registering is what turns this from a guess into a certainty for the values
   * peek actually holds, and it is the one part of this file that does not rely
   * on recognising a shape.
   */
  remember(secret: string | null | undefined): void
  scrub(text: string): string
}

export function createScrubber(): Scrubber {
  const secrets: string[] = []
  return {
    remember(secret) {
      // The length floor is `redact`'s own rule, restated here so a caller
      // cannot register `""` and be surprised that nothing happened.
      if (typeof secret !== 'string' || secret.length < 8) return
      if (secrets.includes(secret)) return
      secrets.push(secret)
    },
    scrub(text) {
      // Known literals first: they are exact, and running them before the
      // patterns means a token that also matches `BEARER_RE` is masked by the
      // rule that cannot be fooled.
      let out = redact(text, secrets)
      out = maskUrlCredentials(out)
      out = out.replace(AUTH_HEADER_RE, (_match, name: string) => `${name}: ***`)
      out = out.replace(BEARER_RE, 'Bearer ***')
      out = out.replace(ASSIGNED_SECRET_RE, (_match, name: string, sep: string) => `${name}${sep}***`)
      return out
    },
  }
}
