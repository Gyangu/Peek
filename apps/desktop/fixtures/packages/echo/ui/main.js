/**
 * The echo fixture's script, in a file of its own because it has to be.
 *
 * The document CSP served with every `peek-package://` response is
 * `script-src 'self'` (`main/packages/assets.ts`), so an inline `<script>` here
 * is not a tidiness question: it is refused, the frame comes up as an empty
 * `<svg>`, and the only trace is one console line. `bench-package-frame.mjs`
 * caught exactly that — the fixture's first version carried its logic inline and
 * never reached `ready`.
 */

const NODE_COUNT = 300
const EDGE_COUNT = 300
const SVG_NS = 'http://www.w3.org/2000/svg'

// A fixed seed, and integer arithmetic only. `Math.random` and anything
// reading the clock would put a different picture on screen each run,
// which is the one property this fixture exists to not have.
function positions() {
  let s = 0x9e3779b9
  const out = []
  for (let i = 0; i < NODE_COUNT; i += 1) {
    s = (s ^ (s << 13)) >>> 0
    s = (s ^ (s >>> 17)) >>> 0
    s = (s ^ (s << 5)) >>> 0
    out.push({ x: 60 + (s % 880), y: 60 + ((s >>> 9) % 880) })
  }
  return out
}

const stage = document.getElementById('stage')
const caption = document.getElementById('caption')
const home = positions()
const nodes = []
const edges = []

// Edges first so they paint under the nodes; `i` and `i * 7` is an
// arbitrary but fixed chord pattern, chosen only because it spreads the
// lines across the stage instead of leaving them on the hull.
for (let i = 0; i < EDGE_COUNT; i += 1) {
  const a = home[i % NODE_COUNT]
  const b = home[(i * 7 + 1) % NODE_COUNT]
  const line = document.createElementNS(SVG_NS, 'line')
  line.setAttribute('x1', String(a.x))
  line.setAttribute('y1', String(a.y))
  line.setAttribute('x2', String(b.x))
  line.setAttribute('y2', String(b.y))
  stage.appendChild(line)
  edges.push(line)
}
for (let i = 0; i < NODE_COUNT; i += 1) {
  const dot = document.createElementNS(SVG_NS, 'circle')
  dot.setAttribute('cx', String(home[i].x))
  dot.setAttribute('cy', String(home[i].y))
  dot.setAttribute('r', '4')
  stage.appendChild(dot)
  nodes.push(dot)
}

let framesDrawn = 0
let attrWrites = 0
let spinning = false
let phase = 0

/**
 * The loud case: every node and every edge endpoint rewritten per frame.
 *
 * Positions orbit their fixed home rather than being regenerated, so the
 * work per frame is constant too — a benchmark that saw the frame cost
 * drift would not be able to tell that from the host drifting.
 */
function spin() {
  if (!spinning) return
  phase += 0.02
  for (let i = 0; i < NODE_COUNT; i += 1) {
    const r = 6 + (i % 5)
    nodes[i].setAttribute('cx', String(home[i].x + r * Math.cos(phase + i)))
    nodes[i].setAttribute('cy', String(home[i].y + r * Math.sin(phase + i)))
    attrWrites += 2
  }
  for (let i = 0; i < EDGE_COUNT; i += 1) {
    const a = i % NODE_COUNT
    edges[i].setAttribute('x1', nodes[a].getAttribute('cx'))
    edges[i].setAttribute('y1', nodes[a].getAttribute('cy'))
    attrWrites += 2
  }
  framesDrawn += 1
  requestAnimationFrame(spin)
}

function setSpinning(next) {
  if (next === spinning) return
  spinning = next
  if (spinning) requestAnimationFrame(spin)
}

/**
 * What a benchmark reads to prove the size did not move.
 *
 * `elementCount` is counted off the live DOM rather than reported from
 * the constants above: the claim is about what is on screen, and a
 * number computed from the same constants that built it could not fail.
 */
window.__peekEchoFixture = {
  get nodeCount() {
    return NODE_COUNT
  },
  get edgeCount() {
    return EDGE_COUNT
  },
  get elementCount() {
    return stage.getElementsByTagName('*').length
  },
  get framesDrawn() {
    return framesDrawn
  },
  /* Tallied next to the writes rather than derived from the counts above, for
   * the same reason `elementCount` is read off the DOM: a benchmark that printed
   * "600 attributes per frame" from a constant would keep printing it after the
   * loop stopped writing them. */
  get attrWrites() {
    return attrWrites
  },
  get spinning() {
    return spinning
  },
}

/* --- the host channel ------------------------------------------- *
 *
 * Same handshake as `packages/db-neo4j/ui/main.ts`: adopt the port, then
 * announce `ready`. Announcing first reopens the window in which `init`
 * arrives before `onmessage` is installed.
 *
 * Messages are read defensively but not validated against a schema —
 * this frame draws a constant, so the only field it can act on is
 * `state.spin`, and everything else is caption text. */
let port = null

function apply(state) {
  setSpinning(state !== null && typeof state === 'object' && state.spin === true)
}

window.addEventListener('message', (event) => {
  if (port !== null || !(event.ports && event.ports[0])) return
  port = event.ports[0]
  port.onmessage = (msg) => {
    const m = msg.data
    if (m === null || typeof m !== 'object') return
    if (m.t === 'init' || m.t === 'state') apply(m.state)
    if (m.t === 'data') {
      const n = typeof m.rowCount === 'number' ? m.rowCount : 0
      // Row count in the caption, never in the element count.
      caption.textContent = `echo fixture — ${NODE_COUNT} nodes, ${EDGE_COUNT} edges, ${n} row(s)`
    }
  }
  port.start()
  port.postMessage({ t: 'ready' })
})

caption.textContent = `echo fixture — ${NODE_COUNT} nodes, ${EDGE_COUNT} edges`
