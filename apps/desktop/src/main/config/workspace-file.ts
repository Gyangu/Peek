/**
 * `~/.peek/workspace.json` — the desk as it was left.
 *
 * ## What is in it, and why that is the whole trick
 *
 * Views are stored as **`ViewOpenSpec`s, not `ViewState`s**. The two types are
 * the line `docs/PLAN.md` said restoring a layout would have to draw and did not
 * have: a spec is what a view *is* (`ref`, `filter`, the text in the editor), a
 * state is that plus what happened to it in this session (`cursorToken`,
 * `resultId`, `status`, `error`). Persisting specs means the session half has no
 * field to live in — there is no `cursorToken` to accidentally save, so there is
 * no rule to get wrong.
 *
 * The second consequence is why nothing here validates a spec: a restore
 * replays `view.open` / `layout.setLayout` through the Command Bus, so every
 * check those commands already make — the layout invariants P1–P6, the tree
 * caps, each spec's own zod schema — runs on this file's contents. Parsing here
 * only has to establish the *shape around* the specs (which view goes in which
 * tab of which panel). A spec that has gone bad fails its own `view.open` and
 * costs one view, not the file.
 *
 * ## Two kinds of id, neither of them a runtime id
 *
 * `ConnId`, `ViewId` and `PanelId` are minted per process and mean nothing
 * across a restart, so the file carries its own local refs (`c1`, `v3`, `p2`)
 * and, for connections, the one durable name peek already has: the connection
 * book's `identity` — "which server and which account", the same string
 * `SavedConnection.identity` carries. Restoring resolves it back to a book entry
 * (credential included, out of the OS keychain) and opens it.
 *
 * ## Failure posture
 *
 * A file that cannot be read is moved aside to `workspace.json.bad` and the app
 * starts with an empty workspace. Renamed rather than deleted or overwritten:
 * it describes work somebody arranged by hand, and it is the only evidence of
 * what went wrong. Every read failure degrades — a workspace that will not load
 * is a bad morning, a launch that will not finish is a broken app.
 */

import { existsSync, renameSync } from 'node:fs'
import { readJsonFile, writeJsonFile } from './json-file'
import { WORKSPACE_QUARANTINE_SUFFIX } from './paths'

/**
 * Bumped when a file this build writes can no longer be read by the code above.
 * A file from the future is not read at all — a newer peek may have written
 * fields whose absence changes meaning, and half-restoring someone's desk is
 * worse than not restoring it.
 */
export const WORKSPACE_FILE_VERSION = 1

/** A connection some view is looking at, named the way the connection book names it. */
export interface PersistedConnection {
  /** Local ref, referenced by `PersistedView.conn`. */
  ref: string
  /** `SavedConnection.identity` — driver, host, port, database, user. Never a credential. */
  identity: string
}

export interface PersistedView {
  /** Local ref, referenced by `PersistedPanel.views`. */
  ref: string
  /**
   * Which connection this view is a window onto, as a `PersistedConnection.ref`.
   *
   * Absent only for a chat, the one view kind that is a peer of the connections
   * rather than a child of one (`ConnectedViewBase` in core). The restore puts
   * the resolved `ConnId` back into the spec.
   */
  conn?: string
  /**
   * A `ViewOpenSpec` minus its `connId`, verbatim and unvalidated — see the
   * header. `unknown` is the honest type: this file's reader is not the thing
   * that decides whether a spec is well formed, `view.open` is.
   */
  spec: unknown
  /**
   * The two things a `ViewOpenSpec` cannot carry, so they ride alongside and are
   * replayed as a `view.update` after the view is open:
   *
   * - `autoRefreshMs` exists on `ViewPatch` only (opening a view with a timer
   *   already running is not something any caller has needed);
   * - a tree's `selected` node, likewise — the spec has `expanded` and stops there.
   */
  autoRefreshMs?: number
  treeSelected?: string
}

export interface PersistedPanel {
  type: 'panel'
  /** Local ref. `layout.setLayout` echoes it back as `key`, which is how panels are matched up again. */
  key: string
  /** Tab-bar order (P6), as `PersistedView.ref`s. */
  views: string[]
  /** The visible tab; absent for an empty panel. */
  active?: string
}

export interface PersistedSplit {
  type: 'split'
  dir: 'row' | 'col'
  ratio?: number[]
  children: PersistedNode[]
}

export type PersistedNode = PersistedSplit | PersistedPanel

export interface PersistedWorkspace {
  version: number
  /** ISO, for a human reading the file. Nothing branches on it. */
  savedAt: string
  connections: PersistedConnection[]
  views: PersistedView[]
  layout: PersistedNode
  /** The focused panel, as a `PersistedPanel.key`. */
  focusPanel?: string
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export type WorkspaceReadOutcome =
  /** No file yet — a first launch, or a workspace that was never saved. Not a failure. */
  | { kind: 'absent' }
  | { kind: 'ok'; workspace: PersistedWorkspace }
  /** The file existed and could not be used; `movedTo` is where it was put, or null when even that failed. */
  | { kind: 'corrupt'; movedTo: string | null; reason: string }

export function readWorkspaceFile(path: string): WorkspaceReadOutcome {
  if (!existsSync(path)) return { kind: 'absent' }

  const raw = readJsonFile(path)
  if (raw === null) return quarantine(path, 'the file is not readable JSON')

  const parsed = parseWorkspaceFile(raw)
  if (parsed === null) return quarantine(path, 'the file is not a workspace this build understands')

  return { kind: 'ok', workspace: parsed }
}

function quarantine(path: string, reason: string): WorkspaceReadOutcome {
  const target = `${path}${WORKSPACE_QUARANTINE_SUFFIX}`
  try {
    renameSync(path, target)
    return { kind: 'corrupt', movedTo: target, reason }
  } catch {
    // Nowhere to move it to (a read-only directory, a name already taken by
    // something undeletable). The workspace is still not restored, and saying so
    // is still better than throwing on the launch path.
    return { kind: 'corrupt', movedTo: null, reason }
  }
}

/**
 * Structure only. Anything malformed makes the whole file unusable rather than
 * being repaired: a half-understood layout would restore a desk nobody arranged.
 * The exception is `spec`, which is passed through — see the header.
 */
export function parseWorkspaceFile(raw: unknown): PersistedWorkspace | null {
  if (!isRecord(raw)) return null
  if (raw['version'] !== WORKSPACE_FILE_VERSION) return null

  const connections = parseConnections(raw['connections'])
  const views = parseViews(raw['views'])
  const layout = parseNode(raw['layout'])
  if (connections === null || views === null || layout === null) return null

  const savedAt = typeof raw['savedAt'] === 'string' ? raw['savedAt'] : ''
  const focusPanel = raw['focusPanel']

  return {
    version: WORKSPACE_FILE_VERSION,
    savedAt,
    connections,
    views,
    layout,
    ...(typeof focusPanel === 'string' && focusPanel.length > 0 ? { focusPanel } : {}),
  }
}

function parseConnections(raw: unknown): PersistedConnection[] | null {
  if (!Array.isArray(raw)) return null
  const out: PersistedConnection[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    const ref = entry['ref']
    const identity = entry['identity']
    if (!isNonEmptyString(ref) || !isNonEmptyString(identity)) return null
    out.push({ ref, identity })
  }
  return out
}

function parseViews(raw: unknown): PersistedView[] | null {
  if (!Array.isArray(raw)) return null
  const out: PersistedView[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    const ref = entry['ref']
    const spec = entry['spec']
    if (!isNonEmptyString(ref) || !isRecord(spec)) return null

    const conn = entry['conn']
    const autoRefreshMs = entry['autoRefreshMs']
    const treeSelected = entry['treeSelected']
    out.push({
      ref,
      spec,
      ...(isNonEmptyString(conn) ? { conn } : {}),
      ...(typeof autoRefreshMs === 'number' && Number.isFinite(autoRefreshMs) ? { autoRefreshMs } : {}),
      ...(isNonEmptyString(treeSelected) ? { treeSelected } : {}),
    })
  }
  return out
}

function parseNode(raw: unknown): PersistedNode | null {
  if (!isRecord(raw)) return null

  if (raw['type'] === 'panel') {
    const key = raw['key']
    const views = raw['views']
    if (!isNonEmptyString(key)) return null
    if (!Array.isArray(views) || !views.every(isNonEmptyString)) return null
    const active = raw['active']
    return {
      type: 'panel',
      key,
      views: [...views],
      ...(isNonEmptyString(active) ? { active } : {}),
    }
  }

  if (raw['type'] === 'split') {
    const dir = raw['dir']
    const children = raw['children']
    if (dir !== 'row' && dir !== 'col') return null
    // Two is the floor `layout.setLayout` enforces anyway; refusing it here means
    // a one-child split is reported as a bad file rather than as a failed command.
    if (!Array.isArray(children) || children.length < 2) return null

    const parsed: PersistedNode[] = []
    for (const child of children) {
      const node = parseNode(child)
      if (node === null) return null
      parsed.push(node)
    }

    const ratio = raw['ratio']
    const usableRatio =
      Array.isArray(ratio) &&
      ratio.length === parsed.length &&
      ratio.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)

    return {
      type: 'split',
      dir,
      children: parsed,
      ...(usableRatio ? { ratio: [...(ratio as number[])] } : {}),
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** Atomic, 0600, same as every other file under `~/.peek`. Throws; the caller decides who hears about it. */
export function writeWorkspaceFile(path: string, workspace: PersistedWorkspace): void {
  writeJsonFile(path, workspace)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
