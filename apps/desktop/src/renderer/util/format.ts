import type { LogicalType } from '@peek/core'
import { isTruncatedValue } from '@peek/core'
import { isPendingCell } from '../state/resultCache'

/* ==================================================================
 * Cell rendering helpers.
 *
 * Pure functions throughout — no components, no closure allocation — because the
 * grid's hot path calls them hundreds of times per frame.
 *
 * None of the output here is localized, and that is the point: NULL, the pending
 * marker, hex dumps and JSON are how the *data* is spelled, not prose about it. A
 * user comparing a cell against psql output or a JSON payload needs both sides to
 * read the same.
 * ================================================================== */

export const NULL_TEXT = 'NULL'
export const PENDING_TEXT = '···'

/** Text for one cell. Presentation only; the value itself is never modified. */
export function cellText(v: unknown): string {
  if (isPendingCell(v)) return PENDING_TEXT
  if (v === null || v === undefined) return NULL_TEXT
  switch (typeof v) {
    case 'string':
      return v.length > 512 ? `${oneLine(v.slice(0, 512))}…` : oneLine(v)
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(v)
    case 'object': {
      if (isTruncatedValue(v)) {
        const head = oneLine(v.preview.slice(0, 256))
        return `${head}…`
      }
      if (v instanceof Date) return isoLocal(v)
      if (ArrayBuffer.isView(v)) return hexPreview(v)
      return oneLine(safeJson(v, 512))
    }
    default:
      return String(v)
  }
}

/* ==================================================================
 * The cell's classes, in two halves.
 *
 * Until the Tailwind migration reached this file these were six modifier names
 * — a word each — and `components/grid.css` held the rules that painted them.
 * That split was the last thing keeping the grid's stylesheet alive, and it was
 * a file-ownership accident rather than a technical one: the modifiers are
 * minted here, the rules lived one directory over, and no round owned both.
 *
 * ## Why every string below is written out whole
 *
 * Tailwind's extractor reads raw bytes and compiles every candidate it finds. It
 * cannot see through a `+`, so a name assembled from a prefix and a value is a
 * name that never reaches the stylesheet: the class is not merely unaudited, it
 * paints nothing at all, and the cell silently loses that colour. Every token
 * therefore appears here, spelled out, in a constant.
 *
 * Joining two whole constants with a space at the call site is a different
 * thing and is safe — both halves are literals in this file, so the scanner has
 * already seen every token in them. It is the *token* that may not be split.
 * See migration record §11.5 and the header of `__tests__/sourceScan.ts`.
 *
 * ## Why the background is a separate half, decided here rather than in CSS
 *
 * A class list has no cascade. The five backgrounds a cell can have used to be
 * ordered by selector specificity and by the order of the rules in the sheet —
 * the zebra stripe was deliberately written after the hover rule so it would
 * win a tie, and the focused cell needed `!important` to beat both. Written as
 * four background utilities on one element, that ordering would be Tailwind's
 * emission order and not ours, which is the failure `ui/CLAUDE.md` calls "two
 * classes from one utility family". So exactly one background class is chosen,
 * here, from the state the caller already knows.
 *
 * The one state the caller cannot know is the pointer, and that is the one that
 * stays in CSS — as a `group-hover:` variant against the row, which is what
 * replaced the `.grid-row:hover .grid-cell` descendant selector.
 * ================================================================== */

/**
 * Geometry, grid lines and type — identical on every cell whatever it holds.
 *
 * The line height is `--leading-row`, derived from the row height rather than
 * written as a number, because `vscroll.ts` computes every scroll offset in the
 * product from that row height and a cell whose text does not move with it
 * slides off its own row.
 *
 * **It used to be `--leading-cell` (23px) and that was the product's worst half
 * pixel.** The 1px came off to make room for the cell's own `border-b` — but
 * the row number this cell has to line up with has no bottom border, only a
 * right one, so every row of data sat half a pixel above its own row number.
 * Measured with a `Range` around each text node, because the element boxes are
 * both 24px and would have said "aligned": row number centre 12, cell centre
 * 11.5 (§31.3).
 *
 * Both grid lines are `--shadow-cell` now — one token, two `inset` shadows,
 * neither of which takes layout space. One token rather than two classes: a
 * class list has no cascade, so `shadow-rule-r shadow-rule-b` would be decided
 * by Tailwind's emission order and one of the two lines would simply not paint.
 *
 * `--text-body` rather than the chrome rung: a data cell is monospace, and
 * mono glyphs carry more ink than proportional ones at the same nominal size.
 * That compensation used to be `--fs-data: 11.5px` — half a pixel over the
 * 11px chrome. It is a whole rung now (§31.6).
 */
const CELL = 'grid-cell absolute top-0 h-row leading-row px-cell font-mono text-body truncate shadow-cell'

const CELL_NUM = `${CELL} text-right`
const CELL_NULL = `${CELL} text-fg-faint italic`
const CELL_BOOL = `${CELL} text-cell-bool`
const CELL_JSON = `${CELL} text-cell-json`
const CELL_TRUNC = `${CELL} text-warn cursor-pointer`
const CELL_PENDING = `${CELL} text-fg-faint`

/**
 * What a cell looks like given what is in it: alignment and colour.
 *
 * Returns one of seven module constants, so it still allocates nothing on a hot
 * path that runs hundreds of times a frame. Pair it with `cellSurfaceClass`.
 */
export function cellClass(v: unknown, logical: LogicalType | undefined): string {
  if (isPendingCell(v)) return CELL_PENDING
  if (v === null || v === undefined) return CELL_NULL
  if (isTruncatedValue(v)) return CELL_TRUNC
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return CELL_NUM
    case 'boolean':
      return CELL_BOOL
    case 'object':
      return v instanceof Date ? CELL : CELL_JSON
    default:
      return logical === 'number' || logical === 'bigint' ? CELL_NUM : CELL
  }
}

/* The five backgrounds, as alternatives rather than as a base plus overrides. */
const SURFACE_REST = 'bg-bg group-hover:bg-bg-1'
const SURFACE_STRIPE = 'bg-bg-stripe group-hover:bg-bg-1'
/** A selected row does not change under the pointer, so it carries no variant. */
const SURFACE_ROW_SELECTED = 'bg-row-sel'
/**
 * Inside the dragged rectangle: the focused cell's fill without its ring.
 *
 * No border is drawn around the rectangle as a whole. It is virtualized, so its
 * top and bottom edges are routinely off screen, and half a frame reads as a
 * bug rather than as a boundary. The fill alone says where the block is, and it
 * says it on every row that is actually visible.
 */
const SURFACE_IN_RANGE = 'bg-bg-sel'
/** The anchor cell outranks the rest of its own rectangle, hover included. */
const SURFACE_CELL_SELECTED = 'bg-bg-sel outline outline-accent -outline-offset-1'

/**
 * What a cell is drawn *on*: exactly one background, and the hover variant that
 * goes with it where the row has one.
 *
 * The precedence, read top to bottom: the anchor beats the rest of the rectangle
 * it anchors, which beats the row staged for the chat, which beats the zebra
 * stripe, which beats the resting surface.
 *
 * The middle two can never actually meet: the grid keeps the rectangle and the
 * row selection mutually exclusive, so a cell is offered at most one of them.
 * The order between them is stated anyway rather than left undefined — a total
 * function is worth more than a comment claiming a case cannot arise, and if a
 * later change does let them overlap, the answer is already decided.
 */
export function cellSurfaceClass(
  odd: boolean,
  rowSelected: boolean,
  cellSelected: boolean,
  inRange = false,
): string {
  if (cellSelected) return SURFACE_CELL_SELECTED
  if (inRange) return SURFACE_IN_RANGE
  if (rowSelected) return SURFACE_ROW_SELECTED
  return odd ? SURFACE_STRIPE : SURFACE_REST
}

/** Whether the value is worth opening up: truncated values, JSON, long text. */
export function isExpandable(v: unknown): boolean {
  if (isPendingCell(v) || v === null || v === undefined) return false
  if (isTruncatedValue(v)) return true
  if (typeof v === 'string') return v.length > 80 || v.includes('\n')
  if (typeof v === 'object') return true
  return false
}

/** Full text for the modal; JSON is pretty-printed. */
export function fullValueText(v: unknown): string {
  if (isPendingCell(v)) return PENDING_TEXT
  if (v === null || v === undefined) return NULL_TEXT
  if (isTruncatedValue(v)) return v.preview
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString()
    if (ArrayBuffer.isView(v)) return hexDump(v)
    return safeJson(v, Number.MAX_SAFE_INTEGER, 2)
  }
  return String(v)
}

/* ------------------------------------------------------------------ */

function oneLine(s: string): string {
  return s.includes('\n') || s.includes('\r') || s.includes('\t') ? s.replace(/[\r\n\t]+/g, ' ') : s
}

function isoLocal(d: Date): string {
  if (Number.isNaN(d.getTime())) return 'Invalid Date'
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    (d.getMilliseconds() ? `.${p(d.getMilliseconds(), 3)}` : '')
  )
}

function hexPreview(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, Math.min(v.byteLength, 16))
  let out = '\\x'
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return v.byteLength > 16 ? `${out}… (${v.byteLength}B)` : out
}

function hexDump(v: ArrayBufferView): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16)
    let hex = ''
    let ascii = ''
    for (const b of slice) {
      hex += `${b.toString(16).padStart(2, '0')} `
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.'
    }
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(48, ' ')} ${ascii}`)
  }
  return lines.join('\n')
}

function safeJson(v: unknown, maxLen: number, indent?: number): string {
  try {
    const s = JSON.stringify(v, jsonReplacer, indent)
    if (s === undefined) return String(v)
    return s.length > maxLen ? s.slice(0, maxLen) : s
  } catch {
    return String(v)
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value.toString()}n` : value
}

/* ------------------------------------------------------------------ */
/* Small helpers for the status bar                                       */
/* ------------------------------------------------------------------ */

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * Thousands grouping for row counts.
 *
 * Pinned to en-US rather than the active locale, and `t()` never groups numbers
 * on its own (see `formatTemplate` in core): a row count is an address into the
 * grid, and it has to line up with the row-number gutter, the scrollbar bubble
 * and whatever the user reads back to a colleague. Grouping is presentation, but
 * a number that changes shape with the UI language is a number two people cannot
 * compare.
 */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
