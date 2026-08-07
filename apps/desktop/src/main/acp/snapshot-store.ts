/**
 * A read-only picture of an ACP conversation, for the second and a half before
 * the real one arrives.
 *
 * ## Why this does not contradict "peek stores no ACP transcripts"
 *
 * `agent/session-index.ts` and `agent/endpoint/thread-store.ts` both state the
 * rule this file appears to break: an ACP conversation is written by Claude Code
 * or Codex into their own history, and a second copy in peek would be a second
 * answer to "what does the model remember" — only one of which can be right.
 *
 * That rule is intact, because **this file cannot answer that question**. What
 * it stores is `ChatMessage[]` and nothing else: the projection the window drew.
 * The model's own context — `AgentMessage[]`, the thing an agent would need to
 * continue a conversation — is not here, is not written by any code path, and
 * has no field to live in. The endpoint backend's store keeps both on purpose
 * (there peek *is* the agent, so not storing means zero copies); this keeps one
 * on purpose, and the asymmetry is the whole design.
 *
 * So the dividing line stays where `2026-08-03-chat-history-ownership.md` §1.2
 * drew it — "does this conversation already have an owner" — and this file adds
 * a second line under it: peek may remember **what it showed**, never what the
 * model knows. See `2026-08-06-opening-a-stored-conversation.md` §2.2 and §3.1.
 *
 * ## What it is for
 *
 * `session/load` costs ~1.5s, all of it building a live session — the history
 * itself replays in 3ms (§1.1, measured). A snapshot lets the window draw the
 * conversation immediately and be corrected by the agent's own copy when it
 * lands. It is a placeholder with a deadline, not a source of truth, and §2.4
 * covers what has to happen when the real copy never arrives.
 *
 * ## Shape and failure posture
 *
 * Identical to `EndpointThreadStore`, deliberately: one file per conversation so
 * a corrupt write damages one conversation rather than the catalogue, temp-file
 * + rename so a crash cannot leave a torn file, and every read failure degrading
 * to `null` because a panel that opens without its snapshot is recoverable while
 * one that refuses to open is not.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage } from '@peek/core'

const FILE_VERSION = 1

/**
 * Subdirectory of `~/.peek/chat` the snapshots live in.
 *
 * A sibling of the endpoint backend's `endpoint/` rather than a tenant of it.
 * That directory holds conversations peek owns outright; this one holds pictures
 * of conversations it does not. Putting them together would invite exactly the
 * code that treats the two as one kind of thing.
 */
export const ACP_SNAPSHOT_DIR = 'snapshots'

/**
 * One stored picture.
 *
 * The absence of a `messages` field is load-bearing — see the header. Anyone
 * adding one is changing what this file is, and should read §3.1 first.
 */
export interface AcpSnapshotFile {
  version: typeof FILE_VERSION
  sessionId: string
  /** The transcript, as the window last drew it. */
  transcript: ChatMessage[]
  updatedAt: number
}

export class AcpSnapshotStore {
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  get dir(): string {
    return this.#dir
  }

  path(sessionId: string): string {
    // Session ids come from the agent, which puts them one step further from
    // peek's control than the endpoint backend's `randomUUID()` — so the same
    // check matters more here, not less. This path is joined against a directory
    // and then written to; a traversal would be a write anywhere on disk.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Refusing to build a snapshot path from ${JSON.stringify(sessionId)}.`)
    }
    return join(this.#dir, `${sessionId}.json`)
  }

  /** The stored picture, or `null` when there is none peek can read. */
  read(sessionId: string): AcpSnapshotFile | null {
    let raw: string
    try {
      raw = readFileSync(this.path(sessionId), 'utf8')
    } catch {
      return null // Absent is the normal case: no snapshot until peek has shown it once.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AcpSnapshotFile>
      // A version peek does not know is not a file to guess at. Declining loses
      // a placeholder; guessing wrongly draws a conversation that never happened.
      if (parsed.version !== FILE_VERSION) return null
      if (!Array.isArray(parsed.transcript)) return null
      return {
        version: FILE_VERSION,
        sessionId,
        transcript: parsed.transcript as ChatMessage[],
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      }
    } catch {
      return null // Truncated or corrupt. Degrade, do not throw.
    }
  }

  /**
   * Store one picture. Returns whether it landed.
   *
   * An empty transcript is **not** written — it is removed instead. A snapshot
   * of nothing has no placeholder value, and leaving a stale one behind after a
   * `clear` would redraw a conversation the user threw away.
   */
  write(sessionId: string, transcript: readonly ChatMessage[], now: number): boolean {
    if (transcript.length === 0) return this.remove(sessionId)
    const target = this.path(sessionId)
    const temp = `${target}.tmp`
    const body: AcpSnapshotFile = {
      version: FILE_VERSION,
      sessionId,
      transcript: [...transcript],
      updatedAt: now,
    }
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
      writeFileSync(temp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, target)
      return true
    } catch (error) {
      // A snapshot that cannot be written costs the next open its head start and
      // nothing else, so this is a warning and never an error on the conversation.
      console.warn('[peek/acp] could not store the conversation snapshot', error)
      try {
        unlinkSync(temp)
      } catch {
        /* Nothing to clean up. */
      }
      return false
    }
  }

  /**
   * Drop one picture.
   *
   * `true` when the file is gone afterwards, including when it was never there.
   * Unlike the endpoint store's `remove`, a `false` here is not a reason to keep
   * a route alive: nothing is attributed to a snapshot, so an orphan is a wasted
   * file rather than an unreachable conversation.
   */
  remove(sessionId: string): boolean {
    try {
      rmSync(this.path(sessionId), { force: true })
      return true
    } catch (error) {
      console.warn('[peek/acp] could not delete the conversation snapshot', error)
      return false
    }
  }
}
