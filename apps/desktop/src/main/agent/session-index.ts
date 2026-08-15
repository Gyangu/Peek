/**
 * Which backend owns which conversation.
 *
 * ## Why this exists, given that it was ruled out once
 *
 * `docs/design/2026-08-02-chat-session-management.md` says peek adds **no
 * persistence layer** for chats: the catalogue comes from the agent's own
 * `session/list`, because a second copy of a transcript is a second answer to
 * "what does the model remember" and only one of them can be right.
 *
 * That still holds, and this file does not break it. What changed is that there
 * is now more than one backend, and they do not share a catalogue:
 *
 *  - Claude Code and Codex each write history under their own working directory,
 *    in formats that do not recognise each other;
 *  - the endpoint backend has no agent process at all, so there is no
 *    `session/list` to call — peek keeps that history itself.
 *
 * A mixed list needs one place that can answer "who do I ask about this
 * conversation", and none of the three sources can. So this index stores exactly
 * that — a route — and **no transcript**. The history still lives in one place
 * per conversation, and that place is still the backend's. See
 * `docs/design/2026-08-03-pluggable-agent-backends.md` §3.5.
 *
 * ## Failure posture
 *
 * The index is a convenience over authoritative data held elsewhere, so every
 * read failure degrades to "no entries" rather than throwing: a corrupt index
 * must not be able to take the chat panel down, and a rebuilt one costs the user
 * some labels, not a conversation. Writes are atomic (temp file + rename) so a
 * crash mid-write cannot leave a half-written file to be read next launch.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Which kind of backend owns a conversation. */
export type AgentBackendKind = 'acp' | 'endpoint'

/**
 * One conversation's route.
 *
 * Deliberately minimal. Anything derivable from the backend's own record —
 * title, last-updated, message count — is *not* here, because a stale copy of it
 * would be worse than no copy: the list would confidently show the wrong thing.
 * The one exception is `createdAt`, which peek is the only party that knows (it
 * is when the user opened the panel, not when the agent first wrote a file).
 *
 * ## The two optional fields, and why they do not break that rule
 *
 * `title` and `updatedAt` are written **for the endpoint backend only**. That
 * rule above turns on a premise — that some backend has the authoritative copy
 * and can be asked. For `acp` it holds: `session/list` answers both, so storing
 * them here could only produce a stale second answer, and nothing does.
 *
 * The endpoint backend has no agent to ask. peek *is* that backend, so peek is
 * where the authoritative answer lives; leaving these out would not keep the
 * catalogue honest, it would leave every endpoint row without a name. Same
 * principle, opposite conclusion, because the premise is different. See
 * `docs/design/2026-08-03-chat-history-ownership.md` §2.1.
 */
export interface SessionRoute {
  /** The backend's own session id. Identity of the conversation, as before. */
  sessionId: string
  backend: AgentBackendKind
  /**
   * For `acp`, the profile id (`claude-code`, `codex`). For `endpoint`, the
   * model id the conversation was started with — the closest thing that backend
   * has to an agent identity, and what the sessions rail shows on the row.
   */
  agentId: string
  /**
   * The working directory this conversation was created in, when it was not
   * peek's own default.
   *
   * Route information in the strictest sense, and the reason it belongs in a
   * file that deliberately stores nothing derivable: **the backend cannot answer
   * it.** An ACP `session/load` needs the cwd as an *input* — it is how the
   * agent finds the transcript — so a conversation started in a project
   * directory and resumed against `~/.peek/chat` does not come back wrong, it
   * does not come back at all.
   *
   * Absent means the default for that agent, which is what every conversation
   * recorded before 2026-08-15 has and what a conversation that never left the
   * default still gets. See
   * `docs/design/2026-08-15-chat-panel-full-capability.md` §3.4.
   */
  cwd?: string
  /** Epoch millis, set once when the route is first recorded. */
  createdAt: number
  /** Endpoint backend only. Absent means the conversation has no name yet. */
  title?: string
  /** Endpoint backend only. Epoch millis of the last turn. */
  updatedAt?: number
}

interface IndexFile {
  version: 1
  routes: Record<string, SessionRoute>
}

const INDEX_VERSION = 1
export const SESSION_INDEX_FILE = 'sessions.json'

/**
 * Read/write access to the route index.
 *
 * A class rather than free functions because the path is resolved once and every
 * caller must agree on it; a second instance pointed elsewhere would silently
 * split the catalogue in two.
 */
export class SessionIndex {
  readonly #path: string

  /** In-memory mirror. Reads never touch the disk twice; writes update both. */
  #routes: Map<string, SessionRoute> | null = null

  constructor(indexPath: string) {
    this.#path = indexPath
  }

  /** `<chatDir>/sessions.json`. */
  static at(chatDir: string): SessionIndex {
    return new SessionIndex(join(chatDir, SESSION_INDEX_FILE))
  }

  get path(): string {
    return this.#path
  }

  /**
   * Every known route, newest first.
   *
   * Sorted here rather than at the call site so every surface that lists
   * conversations agrees on the order without repeating the rule.
   */
  list(): SessionRoute[] {
    // Last activity, falling back to creation. `updatedAt` is only ever set on
    // endpoint routes, so ACP rows sort exactly as they did — and those are
    // re-sorted by the agent's own `session/list` anyway.
    const when = (r: SessionRoute): number => r.updatedAt ?? r.createdAt
    return [...this.#load().values()].sort((a, b) => when(b) - when(a))
  }

  lookup(sessionId: string): SessionRoute | null {
    return this.#load().get(sessionId) ?? null
  }

  /**
   * Record a route, or leave an existing one alone.
   *
   * Idempotent on purpose: bringing a session up again after an agent restart
   * must not restamp `createdAt` and reshuffle the list under the user.
   */
  record(route: Omit<SessionRoute, 'createdAt'> & { createdAt?: number }): SessionRoute {
    const routes = this.#load()
    const existing = routes.get(route.sessionId)
    if (existing) return existing
    const created: SessionRoute = {
      sessionId: route.sessionId,
      backend: route.backend,
      agentId: route.agentId,
      createdAt: route.createdAt ?? Date.now(),
      // Field by field rather than a spread, so a caller cannot widen what the
      // index stores by passing extra keys — the file's whole discipline is that
      // it holds routing information and nothing that could be mistaken for a
      // transcript. Which also means every new field has to be added here, and
      // the one that was not is why this comment exists.
      ...(route.cwd ? { cwd: route.cwd } : {}),
    }
    routes.set(created.sessionId, created)
    this.#save()
    return created
  }

  /**
   * Update the two mutable fields, leaving identity and `createdAt` alone.
   *
   * Separate from `record` because `record` is deliberately write-once: a
   * session coming back up must not be restamped and reshuffled. This is the
   * other half — the fields that are *supposed* to change as a conversation
   * grows. A `title` that is already set is not overwritten by a later call
   * with a different one; the first user message names the conversation, and a
   * name that moved under the user on every turn would be worse than none.
   *
   * A no-op for an unknown session, and for a route that is not `endpoint`:
   * see the note on {@link SessionRoute}.
   */
  touch(sessionId: string, patch: { title?: string; updatedAt?: number }): SessionRoute | null {
    const routes = this.#load()
    const existing = routes.get(sessionId)
    if (!existing || existing.backend !== 'endpoint') return null
    const next: SessionRoute = {
      ...existing,
      ...(patch.title !== undefined && existing.title === undefined ? { title: patch.title } : {}),
      ...(patch.updatedAt === undefined ? {} : { updatedAt: patch.updatedAt }),
    }
    if (next.title === existing.title && next.updatedAt === existing.updatedAt) return existing
    routes.set(sessionId, next)
    this.#save()
    return next
  }

  remove(sessionId: string): boolean {
    const routes = this.#load()
    if (!routes.delete(sessionId)) return false
    this.#save()
    return true
  }

  /** Drop the in-memory mirror. For tests, and for a config directory that moved. */
  reset(): void {
    this.#routes = null
  }

  #load(): Map<string, SessionRoute> {
    if (this.#routes) return this.#routes
    this.#routes = new Map()
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch {
      return this.#routes // Absent is the normal first-launch state.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IndexFile>
      // A version peek does not know is not a file to guess at. Starting empty
      // costs labels on old rows; misreading a future shape could route a
      // conversation to the wrong backend, which loses it.
      if (parsed.version !== INDEX_VERSION || typeof parsed.routes !== 'object' || parsed.routes === null) {
        return this.#routes
      }
      for (const [id, value] of Object.entries(parsed.routes)) {
        const route = asRoute(id, value)
        if (route) this.#routes.set(route.sessionId, route)
      }
    } catch {
      // Corrupt JSON. Same reasoning as above: degrade, do not throw.
    }
    return this.#routes
  }

  #save(): void {
    const file: IndexFile = { version: INDEX_VERSION, routes: {} }
    for (const [id, route] of this.#load()) file.routes[id] = route
    const temp = `${this.#path}.tmp`
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, this.#path)
    } catch {
      // A chat panel that works but forgets which agent owned a conversation is
      // far better than one that refuses to open because a file is read-only.
      try {
        unlinkSync(temp)
      } catch {
        /* Nothing to clean up. */
      }
    }
  }
}

/** Validate one entry. Anything malformed is dropped rather than repaired. */
function asRoute(id: string, value: unknown): SessionRoute | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const backend = record['backend']
  if (backend !== 'acp' && backend !== 'endpoint') return null
  const agentId = record['agentId']
  if (typeof agentId !== 'string' || agentId.length === 0) return null
  const sessionId = typeof record['sessionId'] === 'string' ? (record['sessionId'] as string) : id
  if (sessionId.length === 0) return null
  const createdAt = record['createdAt']
  const title = record['title']
  const updatedAt = record['updatedAt']
  const cwd = record['cwd']
  return {
    sessionId,
    backend,
    agentId,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    // Dropped rather than rejected when malformed, like `title` beside it: a
    // conversation whose cwd is unreadable falls back to the default, where it
    // may fail to load and say so. Refusing the whole route would instead take
    // the conversation out of the catalogue, which is a worse answer to a
    // hand-edited file.
    ...(typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {}),
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }
}
