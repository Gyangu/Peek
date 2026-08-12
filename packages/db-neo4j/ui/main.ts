import type {
  PackageViewClientMessage,
  PackageDataMessage,
  PackageDataStatus,
  PackageViewHostMessage,
  PackageTheme,
} from '@peek/core'
import type { GraphNodeCell, GraphPathCell, GraphRelCell } from '../src/values'
import type { GraphViewState } from '../src/graph'

/* ==================================================================
 * The neo4j `graph` view, drawing itself.
 *
 * This file is the whole of a Tier C package view
 * (`docs/design/2026-08-03-plugin-architecture.md` §2.6, amended by §2.6bis). It
 * runs in an iframe on `peek-package://neo4j`, which means:
 *
 * - **one MessagePort is the entire I/O.** No preload, so no `window.peek`; the
 *   document CSP carries `connect-src 'none'`, so no fetch, no font URL, no
 *   image URL, no telemetry. Every byte this frame draws arrived on the port.
 * - **no dependencies.** Not a stylistic preference: a CDN is unreachable, and an
 *   npm graph library would be a second supply chain living inside the security
 *   boundary the separate origin exists to draw. The force layout below is about
 *   120 lines, which is cheaper than auditing d3-force's transitive tree.
 * - **every import is erased.** `@peek/core` is imported with `import type` only,
 *   so the bundle carries no zod and shares no chunk with the window — the
 *   arrangement `package-view-channel.ts` describes as "the frame is given types only".
 *   Same for `../src/values` and `../src/graph`: those declarations are the
 *   producer's, and typechecking against them is how a drift in either becomes a
 *   compile error here rather than a blank canvas at runtime. Nothing from
 *   `../src/` may be imported for its *values*, and `graph.ts` least of all — it
 *   composes Cypher, and a frame carrying statement-composition code would
 *   contradict the sentence that file opens with.
 *
 * ## Everything on the port is untrusted input
 *
 * Not because the host is hostile — it is not — but because the frame sits at the
 * end of a `structuredClone` chain that starts in a driver host parsing whatever
 * a database returned. A row with a null where a node should be is a Tuesday. So
 * every shape is checked structurally before use and a bad one is *skipped*,
 * never thrown on: one malformed row must cost one row, not the whole picture.
 * ================================================================== */

/* ==================================================================
 * 1. The port
 * ================================================================== */

let port: MessagePort | null = null

/**
 * `PackageErrorMessageSchema` caps `message` at 2000 characters. Past that, zod
 * rejects the message whole and the host drops it — so the errors interesting
 * enough to be long would be exactly the ones that never arrive. Cut it here
 * instead.
 */
const MAX_ERROR_CHARS = 2000

function send(message: PackageViewClientMessage): void {
  port?.postMessage(message)
}

function reportError(what: string, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause)
  const message = `[graph${viewId === '' ? '' : ` ${viewId}`}] ${what}: ${detail}`
  send({ t: 'error', message: message.slice(0, MAX_ERROR_CHARS) })
}

/**
 * Wrap a handler so an unexpected throw becomes an `error` message.
 *
 * Without this, a single bad frame kills the listener it was raised in: a
 * `pointermove` that throws once ends hover for the rest of the session, and a
 * throw inside the rAF callback ends the layout with no repaint and no clue. The
 * view becomes a still image whose only symptom is that nothing responds —
 * indistinguishable from a converged layout. Routing it to the host's error
 * centre is the entire reason `PackageErrorMessage` is in the protocol.
 */
function guard<A extends unknown[]>(what: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args: A): void => {
    try {
      fn(...args)
    } catch (err) {
      reportError(what, err)
    }
  }
}

/**
 * The handshake, in the order `package-view-channel.ts` fixes it.
 *
 * The host posts the port on the frame's `load`; we adopt it, `start()` it —
 * without which delivery never begins and the view sits empty forever — and only
 * then announce `ready`. Announcing first would reopen the window in which
 * `init` can arrive before `onmessage` is installed, which is the exact race
 * this direction of handshake was chosen to close.
 *
 * We stop listening after the first port, and `event.origin` is deliberately not
 * checked. Pinning an expected origin would mean hard-coding whether the window
 * ships from `file://` (origin `"null"`) or from a custom scheme — a comparison
 * that quietly becomes "reject everything" the day that changes, with a blank
 * frame as the only symptom. The boundary here is the origin this document is
 * *on*, not a string it compares; that is §2.6's position. What the one-shot
 * adoption does buy is that no later `postMessage` can swap the channel out from
 * under us.
 */
function adoptPort(event: MessageEvent): void {
  const incoming = event.ports[0]
  if (incoming === undefined) return
  window.removeEventListener('message', onWindowMessage)
  port = incoming
  incoming.onmessage = guard('handling a host message', onPortMessage)
  incoming.start()
  send({ t: 'ready' })
}

const onWindowMessage = guard('adopting the host port', adoptPort)

function onPortMessage(event: MessageEvent): void {
  const data: unknown = event.data
  const message = readHostMessage(data)
  // Dropped rather than reported. A message we cannot parse is one we also
  // cannot describe usefully, and a host that started speaking a dialect this
  // frame does not know should surface as a version mismatch in the host's own
  // logs — not as a stream of `error` messages from every open graph view.
  if (message === null) return
  applyHostMessage(message)
}

/* ==================================================================
 * 2. Reading host messages
 *
 * The mirror of `parsePackageViewClientMessage` on the other side, minus zod. Written
 * out by hand because importing a validator from `@peek/core` would put a
 * runtime dependency on core inside the frame — the one thing the type-only
 * import exists to prevent.
 * ================================================================== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asTheme(value: unknown): PackageTheme {
  return value === 'light' ? 'light' : 'dark'
}

const STATUSES: readonly string[] = ['idle', 'loading', 'done', 'error']

function asStatus(value: unknown): PackageDataStatus {
  return typeof value === 'string' && STATUSES.includes(value) ? (value as PackageDataStatus) : 'idle'
}

/**
 * `init` degrades; every other message drops.
 *
 * The others can each be skipped and the view carries on with what it has.
 * `init` cannot: skipping it leaves the frame permanently blank with no controls
 * and no explanation, because nothing else in the protocol ever supplies `theme`
 * and `state` from cold. So a malformed `init` is read field by field with
 * defaults rather than rejected as a unit.
 */
function readHostMessage(data: unknown): PackageViewHostMessage | null {
  const m = asRecord(data)
  if (m === null) return null

  switch (m['t']) {
    case 'init':
      return {
        t: 'init',
        viewId: asString(m['viewId'], ''),
        packageKind: asString(m['packageKind'], 'graph'),
        state: asRecord(m['state']) ?? {},
        locale: asString(m['locale'], 'en'),
        theme: asTheme(m['theme']),
      }

    case 'state': {
      const state = asRecord(m['state'])
      return state === null ? null : { t: 'state', state }
    }

    case 'theme':
      return { t: 'theme', theme: asTheme(m['theme']) }

    case 'data': {
      const columns = m['columns']
      const rows = m['rows']
      const count = m['rowCount']
      const error = m['error']
      return {
        t: 'data',
        status: asStatus(m['status']),
        columns: Array.isArray(columns) ? (columns as unknown[]).map((c) => asString(c, '')) : [],
        // A bad `rows` becomes empty rather than dropping the message: an
        // `error` status legitimately arrives with no rows, and dropping it
        // would throw away the error text along with them. The inner arrays are
        // asserted rather than checked here and re-checked per row in `rebuild`,
        // because validating 2000 rows eagerly costs a pass over data most of
        // which the harvester is about to walk anyway.
        rows: Array.isArray(rows) ? (rows as readonly (readonly unknown[])[]) : [],
        rowCount: typeof count === 'number' && Number.isFinite(count) ? count : 0,
        truncated: m['truncated'] === true,
        ...(typeof error === 'string' ? { error } : {}),
      }
    }

    default:
      return null
  }
}

/* ==================================================================
 * 3. View state
 *
 * A *mirror* of `readGraphState` in `../src/graph.ts`, not a second owner. Main
 * re-derives its own copy from the same opaque record and its copy is the one
 * that becomes Cypher; this one only decides what the controls show. The clamps
 * are duplicated so the two agree — a control offering depth 7 while the
 * composer silently clamps to 3 is a control that lies about what ran.
 *
 * The four constants are copied rather than imported for the reason at the top
 * of the file: importing them would drag `composeGraphQuery` into the package
 * bundle. Four numbers with a comment beats Cypher inside the frame.
 * ================================================================== */

const MAX_DEPTH = 3
const DEFAULT_DEPTH = 1
const MAX_NODES = 500
const DEFAULT_NODES = 100

function readViewState(state: Readonly<Record<string, unknown>>): GraphViewState {
  const str = (key: string): string | undefined => {
    const v = state[key]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
  }
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const v = state[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(v)))
  }
  const label = str('label')
  const focus = str('focus')
  return {
    ...(label === undefined ? {} : { label }),
    ...(focus === undefined ? {} : { focus }),
    depth: int('depth', DEFAULT_DEPTH, 1, MAX_DEPTH),
    limit: int('limit', DEFAULT_NODES, 1, MAX_NODES),
  }
}

let viewId = ''
let view: GraphViewState = { depth: DEFAULT_DEPTH, limit: DEFAULT_NODES }
let status: PackageDataStatus = 'idle'
let truncated = false
let rowCount = 0
/** How many rows the last snapshot actually carried. The truncation banner needs
 *  a numerator, and `PackageDataMessage` only states the denominator. */
let shownRows = 0
let queryError: string | null = null
let numbers = new Intl.NumberFormat()

/* ==================================================================
 * 4. Harvesting a graph out of rows
 * ================================================================== */

interface GraphNode {
  id: string
  labels: readonly string[]
  properties: Readonly<Record<string, unknown>>
  x: number
  y: number
  /** This tick's accumulated displacement. Lives on the node so the O(n²) pass
   *  needs no parallel arrays and therefore no index bookkeeping to get wrong. */
  vx: number
  vy: number
  degree: number
  /** Dragged at least once: the layout may move everything around it, but not
   *  it. Released in bulk from the control bar. */
  pinned: boolean
}

interface GraphEdge {
  id: string
  type: string
  source: string
  target: string
  properties: Readonly<Record<string, unknown>>
  /** Index among the edges sharing this node pair; decides how far the curve
   *  bows, so parallel relationships do not stack into a single line. */
  rank: number
}

const nodes = new Map<string, GraphNode>()
const edges = new Map<string, GraphEdge>()
/** Relationships whose endpoints are not in this snapshot. Counted, never drawn
 *  — see `rebuild`. */
let danglingEdges = 0

function readNodeCell(value: unknown): GraphNodeCell | null {
  const m = asRecord(value)
  if (m === null || m['_peek'] !== 'node') return null
  const id = m['id']
  if (typeof id !== 'string' || id === '') return null
  const labels = m['labels']
  return {
    _peek: 'node',
    id,
    labels: Array.isArray(labels)
      ? (labels as unknown[]).filter((l): l is string => typeof l === 'string')
      : [],
    properties: asRecord(m['properties']) ?? {},
  }
}

function readRelCell(value: unknown): GraphRelCell | null {
  const m = asRecord(value)
  if (m === null || m['_peek'] !== 'rel') return null
  const id = m['id']
  const start = m['start']
  const end = m['end']
  if (typeof id !== 'string' || typeof start !== 'string' || typeof end !== 'string') return null
  if (id === '' || start === '' || end === '') return null
  return {
    _peek: 'rel',
    id,
    type: asString(m['type'], ''),
    start,
    end,
    properties: asRecord(m['properties']) ?? {},
  }
}

function readPathCell(value: unknown): GraphPathCell | null {
  const m = asRecord(value)
  if (m === null || m['_peek'] !== 'path') return null
  const segments = m['segments']
  if (!Array.isArray(segments)) return null
  const out: GraphPathCell['segments'] = []
  for (const raw of segments as unknown[]) {
    const seg = asRecord(raw)
    if (seg === null) continue
    const start = readNodeCell(seg['start'])
    const relationship = readRelCell(seg['relationship'])
    const end = readNodeCell(seg['end'])
    // A half-read segment is dropped whole rather than contributing its two
    // nodes. Two dots with no line between them is a more misleading picture
    // than one absent hop: it says "these are unrelated", which is a claim the
    // data never made.
    if (start === null || relationship === null || end === null) continue
    out.push({ start, relationship, end })
  }
  return { _peek: 'path', segments: out }
}

/**
 * One snapshot → the node and edge sets. Returns whether the structure changed,
 * which is what decides if the layout has to run again.
 *
 * **Dispatch is on the `_peek` tag, never on the column name.** `graph.ts`
 * returns exactly two columns, `n` and `p`, so `row[columns.indexOf('n')]` would
 * work today — right up to the first time that query grows a third column or
 * swaps the order, at which point this view silently draws nothing and the cause
 * is three files away. The tag is the contract `values.ts` states in its header
 * ("the frame's harvester dispatches on it"), and it is also the only thing that
 * distinguishes a node cell from a map that happens to have a `labels` key. So
 * `columns` goes unread here, deliberately.
 *
 * Positions survive a rebuild: a node already on screen keeps its coordinates
 * and its pin when a control change re-fetches the same neighbourhood.
 * Re-seeding would make every control change look like a different graph, and
 * the user would have no way to tell "more data arrived" from "the layout
 * reshuffled".
 */
function rebuild(message: PackageDataMessage): boolean {
  const seen = new Set<string>()
  const nextEdges = new Map<string, GraphEdge>()
  let added = 0

  const takeNode = (cell: GraphNodeCell): void => {
    seen.add(cell.id)
    const existing = nodes.get(cell.id)
    if (existing === undefined) {
      const seed = seedPosition(cell.id)
      added += 1
      nodes.set(cell.id, {
        id: cell.id,
        labels: cell.labels,
        properties: cell.properties,
        x: seed.x,
        y: seed.y,
        vx: 0,
        vy: 0,
        degree: 0,
        pinned: false,
      })
      return
    }
    // The same node arrives in many rows by construction — `graph.ts` returns
    // one row per (anchor, incident path), so a hub node appears once per edge.
    // Later copies are the same node; only the fields that can legitimately
    // differ across a refetch are refreshed.
    existing.labels = cell.labels
    existing.properties = cell.properties
  }

  const takeRel = (cell: GraphRelCell): void => {
    if (nextEdges.has(cell.id)) return
    nextEdges.set(cell.id, {
      id: cell.id,
      type: cell.type,
      source: cell.start,
      target: cell.end,
      properties: cell.properties,
      rank: 0,
    })
  }

  /** Depth-capped because a cell can nest — `toCell` maps arrays recursively —
   *  and an unbounded walk over adversarially shaped JSON is a stack overflow
   *  that takes the frame down with it. Four is past anything `graph.ts` can
   *  produce. */
  const takeCell = (cell: unknown, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(cell)) {
      for (const inner of cell as unknown[]) takeCell(inner, depth + 1)
      return
    }
    const node = readNodeCell(cell)
    if (node !== null) {
      takeNode(node)
      return
    }
    const rel = readRelCell(cell)
    if (rel !== null) {
      takeRel(rel)
      return
    }
    const path = readPathCell(cell)
    if (path === null) return
    for (const seg of path.segments) {
      takeNode(seg.start)
      takeNode(seg.end)
      takeRel(seg.relationship)
    }
  }

  for (const raw of message.rows) {
    if (!Array.isArray(raw)) continue
    const cells: readonly unknown[] = raw
    for (const cell of cells) takeCell(cell, 0)
  }

  let removed = 0
  for (const id of [...nodes.keys()]) {
    if (seen.has(id)) continue
    nodes.delete(id)
    removed += 1
  }

  /*
   * An edge whose endpoints are missing is *counted*, not drawn and not faked.
   *
   * `values.ts` keeps `start`/`end` on a rel cell precisely so an edge can be
   * described without its nodes, and the truncated tail of a snapshot produces
   * these routinely. Both alternatives are worse: a placeholder node invents a
   * thing the database never returned and then lets the layout treat it as real,
   * and dropping the edge in silence is exactly the quiet hole §2.6bis refuses
   * to allow. Counting it into the status line is the honest middle.
   */
  danglingEdges = 0
  const previousEdges = edges.size
  edges.clear()
  for (const [id, edge] of nextEdges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      danglingEdges += 1
      continue
    }
    edges.set(id, edge)
  }

  for (const node of nodes.values()) node.degree = 0
  const bundles = new Map<string, number>()
  for (const edge of edges.values()) {
    const a = nodes.get(edge.source)
    const b = nodes.get(edge.target)
    if (a === undefined || b === undefined) continue
    a.degree += 1
    if (b !== a) b.degree += 1
    // Separated by a NUL, spelled as an escape: an element id is arbitrary
    // database-supplied text, so any printable separator is a character two
    // different pairs could collide on — and colliding pairs would share a bundle
    // and bow their edges apart from each other for no reason.
    const key =
      edge.source < edge.target
        ? `${edge.source}\u0000${edge.target}`
        : `${edge.target}\u0000${edge.source}`
    const rank = bundles.get(key) ?? 0
    edge.rank = rank
    bundles.set(key, rank + 1)
  }

  return added > 0 || removed > 0 || edges.size !== previousEdges
}

/* ==================================================================
 * 5. Layout
 *
 * Fruchterman–Reingold: repulsion between every pair, an attractive spring along
 * every edge, a weak pull toward the centre, and a per-tick step capped by a
 * temperature that cools.
 *
 * **Plain O(n²) repulsion, no Barnes–Hut quadtree.** The node ceiling is
 * `MAX_NODES = 500` (`graph.ts`), so the worst case is 125k pair computations a
 * tick — around a millisecond, comfortably inside a frame. A quadtree would
 * trade that for a few hundred lines of tree building plus an approximation
 * parameter, inside a bundle with no test harness of its own, to speed up a size
 * the protocol forbids from arriving. §2.6bis is explicit that the bounded
 * snapshot exists *because* a force layout stops being readable in the low
 * hundreds; writing an asymptotically better layout for sizes this view refuses
 * to display would be paying for the requirement that section deleted.
 * ================================================================== */

/**
 * Layout happens in a fixed virtual space and is fitted to the canvas at draw
 * time. Working directly in pixels instead would make every window resize a
 * re-layout — the graph would rearrange itself while the user drags a splitter,
 * which is motion carrying no information.
 */
const LAYOUT_W = 1000
const LAYOUT_H = 700

const TEMP_START = LAYOUT_W / 8
const TEMP_COOL = 0.97
/** Enough ticks for the cooling schedule to reach a still picture from any
 *  start. A ceiling rather than the expected end: a pathologically oscillating
 *  graph still terminates instead of holding a rAF open forever. */
const MAX_TICKS = 400
/** Converged once the root-mean-square step falls below this, in layout units.
 *  At the fit scales this view produces that is well under a screen pixel — the
 *  point past which further ticks change nothing anyone can see. */
const CONVERGED_RMS = 0.08
/**
 * Centring gravity, as a multiple of the distance from the centre.
 *
 * Not decoration. Fruchterman–Reingold has no term connecting disconnected
 * components, so two components repel each other forever, and a `graph` result
 * is *full* of disconnected components — `OPTIONAL MATCH` returns isolated nodes
 * on purpose, which is the whole reason that clause is in `graph.ts`. Without
 * this term the components drift until they hit the runaway clamp below and the
 * picture becomes a ring of nodes around an empty middle. That is not a
 * prediction: it is what this file did at 0.04, measured, before the number was
 * derived instead of guessed.
 *
 * The value is derived so that it holds at every graph size rather than at the
 * one it was eyeballed on. A node on the rim feels roughly `(n-1)·k²/R` of
 * outward repulsion and `GRAVITY·R` of inward pull, so they balance at
 * `R² = (n-1)·k²/GRAVITY`. Asking for `R ≈ √(area)/2` — the graph filling the
 * layout space and no more — and substituting `k² = area/n` leaves
 * `GRAVITY ≈ 4(n-1)/n`, in which the area and the node count both cancel. A
 * constant near 4 is therefore the *scale-free* answer, and 3 sits just under it
 * so a single connected component still gets to breathe.
 *
 * Magnitude is safe to make this large because the integrator normalises: the
 * step is `min(‖v‖, temperature)` along `v̂`, so a strong term changes where the
 * equilibrium is, never how violently a node gets there.
 */
const GRAVITY = 3

let temperature = 0
let ticks = 0
let rafId = 0

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/**
 * A node's starting point, derived from its element id.
 *
 * Deterministic rather than `Math.random()`, and that is the whole point: with
 * random seeding the same query drawn twice produces two different pictures, so
 * the user cannot tell "the data changed" from "the layout was rerolled".
 * Hashing the id means a node lands in roughly the same region every time it
 * appears — across refetches, across reopens, across sessions.
 */
function seedPosition(id: string): { x: number; y: number } {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const angle = ((hash & 0xffff) / 0x10000) * Math.PI * 2
  const radius = 0.15 + ((hash >>> 16) / 0x10000) * 0.35
  return {
    x: LAYOUT_W / 2 + Math.cos(angle) * radius * LAYOUT_W,
    y: LAYOUT_H / 2 + Math.sin(angle) * radius * LAYOUT_H,
  }
}

/** One simulated step. Returns the RMS displacement, which is the convergence
 *  signal — see `CONVERGED_RMS`. */
function tick(): number {
  const list = [...nodes.values()]
  const n = list.length
  if (n === 0) return 0

  const k = Math.sqrt((LAYOUT_W * LAYOUT_H) / n)
  for (const node of list) {
    node.vx = 0
    node.vy = 0
  }

  for (let i = 0; i < n; i += 1) {
    const a = list[i]
    if (a === undefined) continue
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j]
      if (b === undefined) continue
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 < 0.01) {
        // Two nodes exactly on top of each other have no direction to separate
        // along, and dividing by the distance would produce NaN that poisons
        // every later tick — one coincidence turns the whole graph into a blank
        // canvas. The nudge is derived from the pair's ordinals rather than
        // randomised, so the layout stays reproducible.
        dx = ((i % 7) - 3) * 0.1 + 0.05
        dy = ((j % 7) - 3) * 0.1 + 0.05
        d2 = dx * dx + dy * dy
      }
      const d = Math.sqrt(d2)
      const push = (k * k) / d
      const ux = (dx / d) * push
      const uy = (dy / d) * push
      a.vx += ux
      a.vy += uy
      b.vx -= ux
      b.vy -= uy
    }
  }

  for (const edge of edges.values()) {
    if (edge.source === edge.target) continue
    const a = nodes.get(edge.source)
    const b = nodes.get(edge.target)
    if (a === undefined || b === undefined) continue
    const dx = a.x - b.x
    const dy = a.y - b.y
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const pull = (d * d) / k
    const ux = (dx / d) * pull
    const uy = (dy / d) * pull
    a.vx -= ux
    a.vy -= uy
    b.vx += ux
    b.vy += uy
  }

  let energy = 0
  for (const node of list) {
    // A pinned node still repels and still pulls on its edges — it is an anchor,
    // not a hole in the field. Only the integration step skips it.
    if (node.pinned) continue
    const vx = node.vx + (LAYOUT_W / 2 - node.x) * GRAVITY
    const vy = node.vy + (LAYOUT_H / 2 - node.y) * GRAVITY
    const len = Math.sqrt(vx * vx + vy * vy)
    if (len < 1e-9) continue
    const step = Math.min(len, temperature)
    node.x += (vx / len) * step
    node.y += (vy / len) * step
    // A hard box, because one node escaping to 1e12 collapses the fit transform
    // and puts every other node on a single pixel — a single runaway erases the
    // whole picture rather than only itself.
    node.x = Math.max(-LAYOUT_W, Math.min(LAYOUT_W * 2, node.x))
    node.y = Math.max(-LAYOUT_H, Math.min(LAYOUT_H * 2, node.y))
    energy += step * step
  }

  temperature *= TEMP_COOL
  ticks += 1
  return Math.sqrt(energy / n)
}

/**
 * Reheat, and make sure the loop is running.
 *
 * `fraction` is how much of the initial temperature to restore. New data gets a
 * full 1; a drag gets a fraction, because reheating to full on every pointer
 * move would blow the layout apart under the cursor instead of letting the
 * neighbourhood give way around it.
 */
function kick(fraction: number): void {
  temperature = Math.max(temperature, TEMP_START * fraction)
  if (fraction >= 1) ticks = 0
  startLoop()
}

function startLoop(): void {
  if (nodes.size === 0) {
    stopLoop()
    draw()
    return
  }
  if (reduceMotion.matches) {
    settleSynchronously()
    return
  }
  if (rafId === 0) rafId = requestAnimationFrame(frame)
}

function stopLoop(): void {
  if (rafId !== 0) cancelAnimationFrame(rafId)
  rafId = 0
}

const frame = guard('running the layout', (): void => {
  rafId = 0
  const rms = tick()
  easeTransform(0.18)
  draw()
  /*
   * The loop ends when the picture stops moving.
   *
   * A rAF that never stops is precisely what §2.6bis's one surviving guardrail —
   * the frame-budget kill switch — exists to catch, and being disabled for
   * animating a layout that finished settling ten seconds ago would be a
   * self-inflicted wound. Dragging keeps it alive regardless of the RMS, because
   * the cursor is feeding in energy the displacement test cannot see.
   */
  if (dragging !== null || (rms > CONVERGED_RMS && ticks < MAX_TICKS)) {
    rafId = requestAnimationFrame(frame)
    return
  }
  snapTransform()
  draw()
})

/**
 * The reduced-motion path: solve, then paint once.
 *
 * Respecting `prefers-reduced-motion` cannot mean "animate more gently" here —
 * the settling *is* the animation, and there is no calmer version of two hundred
 * dots crawling across a canvas. So the whole schedule runs in one go and only
 * the result is drawn. It blocks the frame while it runs, bounded by `MAX_TICKS`
 * and the node ceiling, and that is the honest price: a few hundred milliseconds
 * of nothing beats several seconds of motion for someone who asked for none.
 */
function settleSynchronously(): void {
  stopLoop()
  for (let i = 0; i < MAX_TICKS; i += 1) {
    if (tick() <= CONVERGED_RMS) break
  }
  snapTransform()
  draw()
}

/* ==================================================================
 * 6. Drawing
 *
 * Canvas, not SVG. A force layout writes new coordinates for every node on every
 * frame; in SVG that is N attribute mutations per frame, each one a style
 * invalidation and a layout of the retained tree, and it starts dropping frames
 * in the low hundreds of nodes — exactly the size this view is built for. On a
 * canvas the same update is one clear plus one pass of fills, with no retained
 * tree to invalidate. The price is that hit-testing and text placement become
 * ours to write, which is the trade the rest of this section pays.
 * ================================================================== */

function mustFind<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`the document is missing #${id}`)
  return found as unknown as T
}

const stage = mustFind<HTMLDivElement>('stage')
const canvas = mustFind<HTMLCanvasElement>('canvas')
const tip = mustFind<HTMLDivElement>('tip')
const ctx = canvas.getContext('2d')

interface Palette {
  bg: string
  edge: string
  edgeHot: string
  nodeStroke: string
  label: string
  labelHalo: string
  fontUi: string
  swatches: readonly string[]
}

/**
 * Canvas colours come from CSS custom properties, read once per theme change.
 *
 * A 2D context inherits nothing, so every colour it draws has to be a literal
 * from somewhere. Keeping the literals in `style.css` next to the rest of the
 * palette gives the theme one home; hard-coding them here would guarantee that
 * the day someone adjusts `--accent`, the graph keeps the old blue and nobody
 * can find out why. Read once and cached because `getComputedStyle` forces a
 * style recalculation, and doing that inside `draw` would put one in every
 * animation frame.
 */
function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = cs.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  const swatches: string[] = []
  for (let i = 1; i <= 8; i += 1) swatches.push(read(`--node-${String(i)}`, '#4d9cff'))
  return {
    bg: read('--bg', '#16181c'),
    edge: read('--edge', '#454c56'),
    edgeHot: read('--edge-hot', '#8b96a3'),
    nodeStroke: read('--node-stroke', '#16181c'),
    label: read('--label', '#d3d8de'),
    labelHalo: read('--label-halo', '#16181c'),
    fontUi: read('--font-ui', 'sans-serif'),
    swatches,
  }
}

let palette: Palette = readPalette()

/** Deterministic label → swatch, same hash family as `seedPosition`. An
 *  insertion-order palette would repaint the entire graph the day a single new
 *  label happened to arrive first in the result. */
function colourFor(label: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return palette.swatches[hash % palette.swatches.length] ?? '#4d9cff'
}

/** screen = world * scale + offset. Kept as an explicit projection rather than a
 *  `ctx.setTransform`, so stroke widths and type sizes stay in screen pixels
 *  without every one of them having to be divided back out by the scale. */
interface Transform {
  scale: number
  ox: number
  oy: number
}

let transform: Transform = { scale: 1, ox: 0, oy: 0 }
let cssWidth = 0
let cssHeight = 0

/**
 * The fit, recomputed from the layout's bounds.
 *
 * There is no pan and no zoom, and that is a decision rather than an omission: a
 * converged layout routinely puts nodes outside any fixed viewport, and without
 * *some* answer the user is left looking at a crop with no way to reach the
 * rest. Auto-fit is the answer that needs no controls, no gesture vocabulary and
 * no "reset view" button, and it is only viable because `MAX_NODES` bounds how
 * much has to fit at once. Pan and zoom is the thing to add if that ceiling ever
 * moves.
 */
function targetTransform(): Transform {
  if (nodes.size === 0 || cssWidth === 0 || cssHeight === 0) return { scale: 1, ox: 0, oy: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes.values()) {
    if (node.x < minX) minX = node.x
    if (node.y < minY) minY = node.y
    if (node.x > maxX) maxX = node.x
    if (node.y > maxY) maxY = node.y
  }
  const pad = 46
  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)
  const scale = Math.max(
    0.05,
    Math.min(2, Math.min((cssWidth - pad * 2) / spanX, (cssHeight - pad * 2) / spanY)),
  )
  return {
    scale,
    ox: cssWidth / 2 - ((minX + maxX) / 2) * scale,
    oy: cssHeight / 2 - ((minY + maxY) / 2) * scale,
  }
}

/** Ease the fit rather than snapping it. While the layout is still expanding, a
 *  hard-fitted transform rescales the whole canvas every frame, which reads as
 *  jitter instead of as settling. */
function easeTransform(rate: number): void {
  const t = targetTransform()
  transform = {
    scale: transform.scale + (t.scale - transform.scale) * rate,
    ox: transform.ox + (t.ox - transform.ox) * rate,
    oy: transform.oy + (t.oy - transform.oy) * rate,
  }
}

function snapTransform(): void {
  transform = targetTransform()
}

function toScreenX(x: number): number {
  return x * transform.scale + transform.ox
}

function toScreenY(y: number): number {
  return y * transform.scale + transform.oy
}

/** Radius in *screen* pixels, not layout units, so the fit transform can never
 *  shrink a node to a subpixel dot on a wide graph. */
function radiusOf(node: GraphNode): number {
  return 4.5 + Math.min(7, Math.sqrt(node.degree) * 1.8)
}

/** Labels are drawn only while they can be read. Past this many nodes the text
 *  overlaps into a grey smear that also hides the edges beneath it, so the
 *  picture is strictly better without it; hover still names any single node. */
const LABEL_CEILING = 140

/**
 * The most human-looking property, falling back to the node's first label.
 *
 * `name` and `title` first because that is what graph data actually uses for a
 * display string. The element id is never a candidate — it is a database
 * address, and using it would make every node read the same at a glance while
 * being unique enough to look meaningful.
 */
function captionOf(node: GraphNode): string {
  for (const key of ['name', 'title', 'id']) {
    const value = node.properties[key]
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number') return String(value)
  }
  return node.labels[0] ?? 'node'
}

function ellipsize(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function draw(): void {
  if (ctx === null) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  if (nodes.size === 0) return

  const hotId = dragging?.id ?? hovered?.id ?? null

  ctx.lineCap = 'round'
  for (const edge of edges.values()) {
    const a = nodes.get(edge.source)
    const b = nodes.get(edge.target)
    if (a === undefined || b === undefined) continue
    const hot = hotId !== null && (edge.source === hotId || edge.target === hotId)
    ctx.strokeStyle = hot ? palette.edgeHot : palette.edge
    ctx.lineWidth = hot ? 1.6 : 1
    if (a === b) drawSelfLoop(ctx, a, edge.rank)
    else drawLink(ctx, a, b, edge.rank)
  }

  const withLabels = nodes.size <= LABEL_CEILING
  if (withLabels) {
    ctx.font = `11px ${palette.fontUi}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
  }

  for (const node of nodes.values()) {
    const sx = toScreenX(node.x)
    const sy = toScreenY(node.y)
    const r = radiusOf(node)
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = colourFor(node.labels[0] ?? '')
    ctx.fill()
    // A pinned node gets a heavier ring. Dragging is the one action that changes
    // the layout's rules, and it has to stay visible afterwards or the "Release
    // pinned" button has no referent anywhere on screen.
    ctx.lineWidth = node.pinned ? 2.5 : 1.5
    ctx.strokeStyle =
      node.id === hotId ? palette.edgeHot : node.pinned ? palette.label : palette.nodeStroke
    ctx.stroke()

    if (!withLabels) continue
    const caption = ellipsize(captionOf(node), 22)
    // The halo is stroked before the fill: labels sit over edges, and without a
    // background-coloured outline a line passing behind the text makes it
    // unreadable at exactly the densities where labels are still worth drawing.
    ctx.lineWidth = 3
    ctx.strokeStyle = palette.labelHalo
    ctx.strokeText(caption, sx, sy + r + 2)
    ctx.fillStyle = palette.label
    ctx.fillText(caption, sx, sy + r + 2)
  }
}

/** Parallel relationships bow apart by rank. Without the offset, a pair of nodes
 *  with six relationships between them draws one line and five invisible ones,
 *  and the graph understates its own density. */
function drawLink(c: CanvasRenderingContext2D, a: GraphNode, b: GraphNode, rank: number): void {
  const ax = toScreenX(a.x)
  const ay = toScreenY(a.y)
  const bx = toScreenX(b.x)
  const by = toScreenY(b.y)
  c.beginPath()
  if (rank === 0) {
    c.moveTo(ax, ay)
    c.lineTo(bx, by)
  } else {
    const dx = bx - ax
    const dy = by - ay
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    const bow = (rank % 2 === 1 ? 1 : -1) * Math.ceil(rank / 2) * 9
    c.moveTo(ax, ay)
    c.quadraticCurveTo((ax + bx) / 2 - (dy / len) * bow, (ay + by) / 2 + (dx / len) * bow, bx, by)
  }
  c.stroke()
  drawArrow(c, ax, ay, bx, by, radiusOf(b))
}

/** A self-relationship is ordinary in graph data, and a straight line from a
 *  node to itself has zero length — it would draw nothing at all, so the edge
 *  would simply be absent with nothing to indicate it ever existed. */
function drawSelfLoop(c: CanvasRenderingContext2D, a: GraphNode, rank: number): void {
  const sx = toScreenX(a.x)
  const sy = toScreenY(a.y)
  const r = radiusOf(a) + 5 + rank * 4
  c.beginPath()
  c.arc(sx, sy - r * 0.7, r, 0, Math.PI * 2)
  c.stroke()
}

/** Direction matters in a property graph — `(a)-[:OWNS]->(b)` and its reverse
 *  are different facts — so an undirected line would be a lossy drawing of a
 *  directed edge. */
function drawArrow(
  c: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  targetRadius: number,
): void {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < targetRadius + 6) return
  const ux = dx / len
  const uy = dy / len
  const tipX = bx - ux * (targetRadius + 1)
  const tipY = by - uy * (targetRadius + 1)
  const size = 5
  c.beginPath()
  c.moveTo(tipX, tipY)
  c.lineTo(tipX - ux * size + uy * size * 0.5, tipY - uy * size - ux * size * 0.5)
  c.lineTo(tipX - ux * size - uy * size * 0.5, tipY - uy * size + ux * size * 0.5)
  c.closePath()
  c.fillStyle = c.strokeStyle
  c.fill()
}

function resize(): void {
  const rect = stage.getBoundingClientRect()
  cssWidth = Math.max(1, Math.round(rect.width))
  cssHeight = Math.max(1, Math.round(rect.height))
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  // The one place a context transform is used: set once per resize for the
  // device-pixel ratio, so every other line in this section can think purely in
  // CSS pixels.
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  snapTransform()
  draw()
}

/* ==================================================================
 * 7. Interaction
 * ================================================================== */

let hovered: GraphNode | null = null
let dragging: GraphNode | null = null

function nodeAt(sx: number, sy: number): GraphNode | null {
  let best: GraphNode | null = null
  let bestDist = Infinity
  for (const node of nodes.values()) {
    const dx = sx - toScreenX(node.x)
    const dy = sy - toScreenY(node.y)
    const dist = Math.sqrt(dx * dx + dy * dy)
    // Four pixels of slack around the disc: at the scales auto-fit produces, a
    // low-degree node is a 5px dot, and demanding an exact hit on one makes
    // dragging feel broken rather than precise.
    if (dist <= radiusOf(node) + 4 && dist < bestDist) {
      best = node
      bestDist = dist
    }
  }
  return best
}

function pointerPosition(event: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

canvas.addEventListener(
  'pointerdown',
  guard('starting a drag', (event: PointerEvent) => {
    const at = pointerPosition(event)
    const node = nodeAt(at.x, at.y)
    if (node === null) return
    dragging = node
    node.pinned = true
    canvas.setPointerCapture(event.pointerId)
    canvas.classList.add('grabbing')
    hideTip()
    renderChrome()
    kick(0.25)
  }),
)

canvas.addEventListener(
  'pointermove',
  guard('tracking the pointer', (event: PointerEvent) => {
    const at = pointerPosition(event)
    if (dragging !== null) {
      dragging.x = (at.x - transform.ox) / transform.scale
      dragging.y = (at.y - transform.oy) / transform.scale
      // A modest reheat per move, never a full one: the graph should give way
      // around the dragged node, not re-explode from its seed positions.
      kick(0.2)
      return
    }
    const node = nodeAt(at.x, at.y)
    canvas.classList.toggle('grabbable', node !== null)
    if (node === hovered) {
      if (node !== null) positionTip(at.x, at.y)
      return
    }
    hovered = node
    if (node === null) hideTip()
    else showTip(node, at.x, at.y)
    // The hover ring is part of the picture, so it needs a repaint even when the
    // layout has converged and the rAF loop has — correctly — stopped.
    if (rafId === 0) draw()
  }),
)

const endDrag = guard('ending a drag', (event: PointerEvent) => {
  if (dragging === null) return
  dragging = null
  canvas.classList.remove('grabbing')
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  startLoop()
})

canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', endDrag)

canvas.addEventListener(
  'pointerleave',
  guard('leaving the canvas', () => {
    hovered = null
    hideTip()
    if (rafId === 0) draw()
  }),
)

/**
 * Double-click re-centres the graph on a node.
 *
 * This is the one interesting thing the patch channel does, and it is worth
 * being exact about what happens: the frame sends `{focus: <elementId>}` and
 * stops. It does not build a query, does not know what `depth` means in Cypher,
 * and could not run a statement if it wanted to. `composeGraphQuery` in
 * `../src/graph.ts` — package code, running in main — turns that one string into
 * `MATCH (n) WHERE elementId(n) = $p1 …`, and the kernel re-runs the
 * registration's `autoFetch`. The rows come back here as a `data` message. That
 * round trip is exactly the seam §2.6 draws: the frame names *what* it is
 * looking at, trusted code decides *how* to ask.
 */
canvas.addEventListener(
  'dblclick',
  guard('focusing a node', (event: MouseEvent) => {
    const at = pointerPosition(event)
    const node = nodeAt(at.x, at.y)
    if (node === null || node.id === view.focus) return
    send({ t: 'patch', state: { focus: node.id } })
  }),
)

/* ==================================================================
 * 8. Tooltip
 * ================================================================== */

const MAX_TIP_ROWS = 12

/**
 * Format one property for display.
 *
 * `TruncatedValue` is handled explicitly. `values.ts` caps a single property at
 * 4096 characters and replaces the tail with that marker; rendering it through
 * the generic object path would print `{"__peekTruncated":true,…}` and turn
 * "this value is large" into "this value is broken" — the precise confusion the
 * marker was introduced to prevent.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const record = asRecord(value)
  if (record !== null && record['__peekTruncated'] === true) {
    const bytes = record['byteLength']
    const size = typeof bytes === 'number' ? ` (${numbers.format(bytes)} bytes)` : ''
    return `${asString(record['preview'], '')}…${size}`
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // Cyclic or otherwise unserialisable. The structured clone that delivered it
    // makes this close to impossible — but "close to" is not a reason to let one
    // property throw inside a hover handler.
    return String(value)
  }
}

/**
 * Built with `textContent`, never `innerHTML`.
 *
 * Property values are database content, and this frame holds the port. Injected
 * markup here would run on `peek-package://neo4j` with the one capability that
 * matters: the ability to send `patch` messages as this view. The frame has no
 * network, so the usual exfiltration story does not apply — it does have a
 * channel, which is the story that does.
 */
function showTip(node: GraphNode, x: number, y: number): void {
  tip.replaceChildren()

  const head = document.createElement('div')
  head.className = 'tip-head'
  const labels = node.labels.length === 0 ? ['(no label)'] : node.labels
  for (const label of labels) {
    const chip = document.createElement('span')
    chip.className = 'tip-label'
    chip.textContent = label
    chip.style.background = colourFor(label)
    head.append(chip)
  }
  tip.append(head)

  const entries = Object.entries(node.properties)
  const rows = document.createElement('div')
  rows.className = 'tip-rows'
  for (const [key, value] of entries.slice(0, MAX_TIP_ROWS)) {
    const k = document.createElement('span')
    k.className = 'tip-key'
    k.textContent = key
    const v = document.createElement('span')
    v.className = 'tip-val'
    v.textContent = ellipsize(formatValue(value), 64)
    rows.append(k, v)
  }
  tip.append(rows)

  if (entries.length > MAX_TIP_ROWS) {
    const more = document.createElement('div')
    more.className = 'tip-more'
    more.textContent = `+${numbers.format(entries.length - MAX_TIP_ROWS)} more properties`
    tip.append(more)
  }

  const hint = document.createElement('div')
  hint.className = 'tip-hint'
  hint.textContent =
    node.id === view.focus ? 'focused · drag to pin' : 'double-click to focus · drag to pin'
  tip.append(hint)

  tip.hidden = false
  positionTip(x, y)
}

/** Measured after being shown, then flipped if it would leave the stage: the
 *  tooltip is wide and the canvas fills the frame, so anchoring it blindly to
 *  the cursor's right clips it for every node in the right-hand third. */
function positionTip(x: number, y: number): void {
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  const left = x + 14 + width > cssWidth ? Math.max(4, x - 14 - width) : x + 14
  const top = y + 14 + height > cssHeight ? Math.max(4, y - 14 - height) : y + 14
  tip.style.left = `${String(Math.round(left))}px`
  tip.style.top = `${String(Math.round(top))}px`
}

function hideTip(): void {
  tip.hidden = true
}

/* ==================================================================
 * 9. Chrome
 * ================================================================== */

const scopeEl = mustFind<HTMLSpanElement>('scope')
const pendingEl = mustFind<HTMLSpanElement>('pending')
const depthEl = mustFind<HTMLSelectElement>('depth')
const limitEl = mustFind<HTMLSelectElement>('limit')
const unfocusEl = mustFind<HTMLButtonElement>('unfocus')
const unpinEl = mustFind<HTMLButtonElement>('unpin')
const truncatedBanner = mustFind<HTMLDivElement>('banner-truncated')
const errorBanner = mustFind<HTMLDivElement>('banner-error')
const overlay = mustFind<HTMLDivElement>('overlay')
const overlayTitle = mustFind<HTMLParagraphElement>('overlay-title')
const overlayDetail = mustFind<HTMLParagraphElement>('overlay-detail')
const statusbar = mustFind<HTMLElement>('statusbar')

const DEPTH_CHOICES = [1, 2, 3]
const LIMIT_CHOICES = [25, 50, 100, 250, MAX_NODES]

/**
 * Fill a select and select `current`.
 *
 * `current` is inserted when it is not one of the offered values, and that case
 * is not hypothetical: `state` is an opaque record the kernel stores verbatim,
 * and an MCP client or a restored workspace can put `137` in it. Assigning an
 * absent value to `select.value` silently leaves the first option selected, so
 * the control would claim the query used 25 nodes while it used 137 — a private
 * source of truth created by one line of DOM behaviour.
 */
function fillSelect(select: HTMLSelectElement, choices: readonly number[], current: number): void {
  const values = choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b)
  select.replaceChildren()
  for (const value of values) {
    const option = document.createElement('option')
    option.value = String(value)
    option.textContent = String(value)
    select.append(option)
  }
  select.value = String(current)
}

/**
 * Redraw every control from `view`.
 *
 * `view` is only ever assigned from an `init` or a `state` message, so this is a
 * pure function of what the host last said. Applying a control's new value
 * optimistically would make the frame the second owner of the view's state, and
 * the two would disagree the first time main clamped something —
 * `readGraphState` pins `depth` to 3 and `limit` to 500, and a select still
 * showing 900 after that clamp is a control lying about the query that ran.
 *
 * There is deliberately no label picker. Offering one would need the database's
 * label list, and this frame has no way to ask for it: there is no `fetchMore`,
 * no capability access, and `connect-src 'none'`. The label is set by whoever
 * opened the view, and the bar reports it rather than pretending to own it.
 */
function renderChrome(): void {
  scopeEl.textContent =
    view.focus !== undefined
      ? `Focused on ${ellipsize(view.focus, 28)}`
      : view.label === undefined
        ? 'All labels'
        : `:${view.label}`
  scopeEl.title = view.focus ?? view.label ?? 'Every label in the database'

  fillSelect(depthEl, DEPTH_CHOICES, view.depth)
  fillSelect(limitEl, LIMIT_CHOICES, view.limit)

  // `graph.ts` ignores depth when there is no focus, so the control says so
  // rather than accepting a change that would visibly do nothing.
  depthEl.disabled = view.focus === undefined
  depthEl.title =
    view.focus === undefined
      ? 'Depth applies once the view is focused on a node'
      : 'Hops to expand around the focused node'

  unfocusEl.hidden = view.focus === undefined
  unpinEl.hidden = ![...nodes.values()].some((node) => node.pinned)
  pendingEl.hidden = !(status === 'loading' && nodes.size > 0)
}

/**
 * The states a fetch can be in, each with somewhere to look.
 *
 * The rule is that the canvas is never blank without a sentence beside it. A
 * graph view drawing nothing is indistinguishable from a graph view that is
 * broken, and both are indistinguishable from a database with no matching
 * nodes — unless the frame says which one it is.
 */
function renderStatus(): void {
  const empty = nodes.size === 0

  errorBanner.hidden = queryError === null || empty
  if (queryError !== null) errorBanner.textContent = queryError

  /*
   * The truncation banner. It stays up for as long as the snapshot is partial
   * and has no dismiss control, because §2.6bis keeps exactly one guarantee from
   * the streaming design it replaced — that loss is loud — and spends it on this
   * field. The rows that did not arrive are not a rounding error in a graph: a
   * missing row is a missing relationship, and a missing relationship is a node
   * that appears unconnected. Reading this picture as complete produces a wrong
   * conclusion about the data, which is worse than any error message.
   */
  truncatedBanner.hidden = !truncated
  if (truncated) {
    truncatedBanner.textContent =
      `Partial graph — built from the first ${numbers.format(shownRows)} of `
      + `${numbers.format(rowCount)} rows. Relationships past that point are missing, so a node shown here `
      + `without edges may well have them. Narrow the label or lower the node limit to see all of it.`
  }

  let title = ''
  let detail = ''
  if (empty && status === 'error') {
    title = 'The graph query failed'
    detail = queryError ?? 'No detail was reported.'
  } else if (empty && status === 'loading') {
    title = 'Running the graph query…'
  } else if (empty && status === 'idle') {
    title = 'Waiting for the first fetch'
  } else if (empty) {
    title = 'No nodes matched'
    detail =
      view.focus !== undefined
        ? 'The focused node no longer exists, or nothing links to it within this depth.'
        : view.label === undefined
          ? 'This database returned no nodes at all.'
          : `Nothing in the database carries the label :${view.label}.`
  }
  overlay.hidden = title === ''
  overlayTitle.textContent = title
  overlayDetail.textContent = detail

  const parts = [
    `${numbers.format(nodes.size)} nodes`,
    `${numbers.format(edges.size)} relationships`,
    `${numbers.format(rowCount)} rows`,
  ]
  if (danglingEdges > 0) {
    parts.push(`${numbers.format(danglingEdges)} relationships lead outside this view`)
  }
  statusbar.textContent = parts.join('  ·  ')
}

depthEl.addEventListener(
  'change',
  guard('changing depth', () => {
    const next = Number(depthEl.value)
    if (!Number.isFinite(next)) return
    send({ t: 'patch', state: { depth: next } })
  }),
)

limitEl.addEventListener(
  'change',
  guard('changing the node limit', () => {
    const next = Number(limitEl.value)
    if (!Number.isFinite(next)) return
    send({ t: 'patch', state: { limit: next } })
  }),
)

/*
 * The way back out of a focus. `null` deletes the key — `PackagePatchMessage`
 * inherits `view.update`'s shallow-merge-with-null-deletes semantics, so this is
 * how the view returns to its label scope. Without it, double-click would be a
 * one-way trip and closing the tab would be the only escape.
 */
unfocusEl.addEventListener(
  'click',
  guard('clearing the focus', () => {
    send({ t: 'patch', state: { focus: null } })
  }),
)

unpinEl.addEventListener(
  'click',
  guard('releasing pinned nodes', () => {
    for (const node of nodes.values()) node.pinned = false
    renderChrome()
    kick(0.5)
  }),
)

/* ==================================================================
 * 10. Applying host messages
 * ================================================================== */

function applyTheme(theme: PackageTheme): void {
  document.documentElement.dataset['theme'] = theme
  palette = readPalette()
  draw()
}

function applyHostMessage(message: PackageViewHostMessage): void {
  switch (message.t) {
    case 'init': {
      viewId = message.viewId
      // An invalid BCP-47 tag throws out of the `Intl` constructor, and the tag
      // comes from the host's settings rather than from anything this frame
      // controls. A bad locale has to cost the thousands separators, not the
      // view.
      try {
        numbers = new Intl.NumberFormat(message.locale)
        document.documentElement.lang = message.locale
      } catch {
        numbers = new Intl.NumberFormat()
      }
      applyTheme(message.theme)
      view = readViewState(message.state)
      renderChrome()
      renderStatus()
      return
    }

    case 'state': {
      const next = readViewState(message.state)
      // A new focus is a different graph before its rows even arrive, and pins
      // from the old one would anchor nodes that are about to be replaced.
      if (next.focus !== view.focus) for (const node of nodes.values()) node.pinned = false
      view = next
      renderChrome()
      renderStatus()
      return
    }

    case 'theme':
      applyTheme(message.theme)
      return

    case 'data': {
      status = message.status
      truncated = message.truncated
      rowCount = message.rowCount
      shownRows = message.rows.length
      queryError =
        message.error ?? (message.status === 'error' ? 'The query failed with no message.' : null)
      const changed = rebuild(message)
      renderChrome()
      renderStatus()
      // Only re-run the layout when the structure actually changed. A `loading`
      // message arrives with the previous rows still on screen, and re-settling
      // an identical node set would shuffle a converged graph for no reason —
      // motion the user cannot attribute to anything.
      if (changed) {
        kick(1)
      } else {
        snapTransform()
        draw()
      }
      return
    }
  }
}

/* ==================================================================
 * 11. Boot
 * ================================================================== */

/*
 * Last-resort reporting. `guard` covers every handler this file installs, but a
 * throw during module evaluation — or a rejection from the platform — would
 * otherwise land in a console that is inside an iframe on a custom scheme, which
 * is about as close to nowhere as a log gets.
 */
window.addEventListener('error', (event: ErrorEvent) => {
  reportError('uncaught', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  reportError('unhandled rejection', event.reason)
})

if (ctx === null) {
  // No 2D context means no view at all. Said out loud, because the alternative
  // is an empty rectangle that looks exactly like an empty database.
  overlay.hidden = false
  overlayTitle.textContent = 'This graph cannot be drawn'
  overlayDetail.textContent = 'The frame could not obtain a 2D canvas context.'
}

new ResizeObserver(guard('resizing', resize)).observe(stage)

// A preference change mid-session re-solves rather than finishing the current
// animation: the user asked for no motion *now*, and politely completing the
// settling they just opted out of would be the wrong reading of the request.
reduceMotion.addEventListener('change', guard('changing motion preference', startLoop))

window.addEventListener('message', onWindowMessage)

resize()
renderChrome()
renderStatus()

