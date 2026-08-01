/* ==================================================================
 * A very small Markdown parser, written by hand.
 *
 * ## Why not a library
 *
 * peek's rule is "no new UI library", and the renderer bundle is held to a cold
 * start under 1.5s (PLAN §8). `react-markdown` + `remark` + `rehype` is ~120KB
 * gzipped and brings a plugin architecture peek would use none of. What an agent
 * actually emits is a narrow slice of CommonMark — paragraphs, fenced code,
 * lists, headings, tables, inline emphasis and code spans — and that slice fits
 * in one readable file.
 *
 * ## The streaming constraint shapes the design
 *
 * Agent text arrives token by token, so this parser is fed **incomplete**
 * Markdown on every frame: an unterminated fence, a half-written `**bold`, a
 * table with a header and no rows yet. Every rule below therefore degrades to
 * literal text instead of throwing or swallowing the rest of the document. An
 * unterminated fence is reported with `closed: false` so the view can render it
 * as code that is still being written rather than as a parse failure.
 *
 * The parser is pure and DOM-free on purpose: it is the part worth unit-testing,
 * and `Markdown.tsx` is then a mechanical walk over the tree.
 * ================================================================== */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'del'; children: MdInline[] }
  | { type: 'link'; href: string; children: MdInline[] }

export type MdAlign = 'left' | 'center' | 'right' | null

export interface MdListItem {
  /** Rendered as a checkbox when the item started with `- [ ]` / `- [x]`. */
  checked: boolean | null
  blocks: MdBlock[]
}

export type MdBlock =
  | { type: 'paragraph'; inline: MdInline[] }
  | { type: 'heading'; level: number; inline: MdInline[] }
  /** `closed` is false while the closing fence has not streamed in yet. */
  | { type: 'code'; lang: string; text: string; closed: boolean }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'hr' }
  | { type: 'table'; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/
const BULLET_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/
const ORDERED_RE = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/

/**
 * Width of a run of whitespace, tabs counted as four columns.
 *
 * **Pass leading whitespace only.** It was once handed whole lines, which made
 * every non-blank line measure as deeply indented: lists then swallowed the
 * paragraphs after them, and the continuation branch sliced real characters off
 * the front of the text ("Put together:" rendered as "t together:"). `leading()`
 * exists so no caller has to remember.
 */
function indentWidth(raw: string): number {
  let n = 0
  for (const ch of raw) n += ch === '\t' ? 4 : 1
  return n
}

/** The run of spaces and tabs a line starts with. */
function leading(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ''
}

/**
 * Parse a Markdown document into blocks.
 *
 * Never throws: anything unrecognised falls through to a paragraph, which is the
 * only behaviour that stays sane while text is still arriving.
 */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const body: string[] = []
      let closed = false
      i += 1
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        // A closing fence is the same character, at least as long, and nothing else.
        if (cur.trimStart().startsWith(marker[0] ?? '`')) {
          const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(cur)
          if (close && (close[1] ?? '').length >= marker.length && (close[1] ?? '')[0] === marker[0]) {
            closed = true
            i += 1
            break
          }
        }
        body.push(cur)
        i += 1
      }
      out.push({ type: 'code', lang, text: body.join('\n'), closed })
      continue
    }

    if (HR_RE.test(line)) {
      out.push({ type: 'hr' })
      i += 1
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      out.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        inline: parseInline(heading[2] ?? ''),
      })
      i += 1
      continue
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i] ?? '')
        if (!m) break
        inner.push(m[1] ?? '')
        i += 1
      }
      out.push({ type: 'quote', blocks: parseBlocks(inner) })
      continue
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const [list, next] = parseList(lines, i)
      out.push(list)
      i = next
      continue
    }

    const table = tryParseTable(lines, i)
    if (table) {
      out.push(table.block)
      i = table.next
      continue
    }

    // Paragraph: run until a blank line or the start of another block.
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ''
      if (cur.trim() === '') break
      if (
        FENCE_RE.test(cur)
        || HEADING_RE.test(cur)
        || HR_RE.test(cur)
        || QUOTE_RE.test(cur)
        || BULLET_RE.test(cur)
        || ORDERED_RE.test(cur)
      ) {
        break
      }
      para.push(cur.trim())
      i += 1
    }
    if (para.length > 0) out.push({ type: 'paragraph', inline: parseInline(para.join('\n')) })
  }

  return out
}

/** Consume one whole list starting at `start`; returns the block and the next index. */
function parseList(lines: string[], start: number): [MdBlock, number] {
  const first = lines[start] ?? ''
  const firstOrdered = ORDERED_RE.exec(first)
  const ordered = firstOrdered !== null
  const baseIndent = indentWidth((ordered ? firstOrdered[1] : (BULLET_RE.exec(first)?.[1] ?? '')) ?? '')
  const startNum = ordered ? Number(firstOrdered[2] ?? '1') : 1

  const items: MdListItem[] = []
  let i = start
  let current: string[] | null = null
  let currentChecked: boolean | null = null

  const flush = (): void => {
    if (current === null) return
    items.push({ checked: currentChecked, blocks: parseBlocks(current) })
    current = null
    currentChecked = null
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      // A blank line only ends the list if the next line is not part of it.
      const ahead = lines[i + 1] ?? ''
      const aheadIsItem = BULLET_RE.test(ahead) || ORDERED_RE.test(ahead)
      const aheadIsContinuation = ahead.trim() !== '' && indentWidth(leading(ahead)) > baseIndent
      if (!aheadIsItem && !aheadIsContinuation) break
      if (current) current.push('')
      i += 1
      continue
    }

    const bullet = BULLET_RE.exec(line)
    const num = ORDERED_RE.exec(line)
    const marker = num ?? bullet
    const markerIndent = marker ? indentWidth(marker[1] ?? '') : -1

    if (marker && markerIndent <= baseIndent) {
      // Sibling item (a different marker style still counts — agents mix them).
      flush()
      let text = marker[3] ?? ''
      const task = TASK_RE.exec(text)
      if (task) {
        currentChecked = (task[1] ?? ' ').toLowerCase() === 'x'
        text = task[2] ?? ''
      }
      current = [text]
      i += 1
      continue
    }

    const lineIndent = leading(line)
    if (current !== null && indentWidth(lineIndent) > baseIndent) {
      // Continuation / nested content: dedent so the nested parse sees it near
      // column zero. Only the whitespace the line actually has is removed —
      // slicing a guessed `baseIndent + 2` used to cut into the text itself
      // whenever the continuation was indented by less than that.
      current.push(line.slice(Math.min(lineIndent.length, baseIndent + 2)))
      i += 1
      continue
    }

    if (current !== null && !marker && line.trim() !== '' && !isBlockStart(line)) {
      // Lazy continuation of the item's paragraph.
      current.push(line.trim())
      i += 1
      continue
    }

    break
  }

  flush()
  return [{ type: 'list', ordered, start: startNum, items }, i]
}

function isBlockStart(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

/**
 * GFM pipe tables. These matter more than usual here: `AttachmentPayload.text`
 * is Markdown by contract, so every result set the user pins to the conversation
 * comes back out of the model as a pipe table.
 */
function tryParseTable(lines: string[], start: number): { block: MdBlock; next: number } | null {
  const header = lines[start] ?? ''
  const delim = lines[start + 1]
  if (delim === undefined) return null
  if (!header.includes('|')) return null
  if (!/^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/.test(delim)) return null

  const head = splitRow(header)
  const alignCells = splitRow(delim)
  if (alignCells.length !== head.length) return null

  const align: MdAlign[] = alignCells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })

  const rows: MdInline[][][] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || !line.includes('|')) break
    const cells = splitRow(line)
    rows.push(cells.map((c) => parseInline(c)))
    i += 1
  }

  return {
    block: { type: 'table', align, head: head.map((c) => parseInline(c)), rows },
    next: i,
  }
}

/** Split a pipe-table row, honouring `\|` escapes. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      buf += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * Inline parsing, in strict precedence order: code spans win over everything
 * (so `` `**not bold**` `` stays literal), then links, then the emphasis
 * delimiters. An unmatched delimiter is emitted as plain text — the common case
 * mid-stream, and the reason nothing here can throw.
 */
export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = []
  let text = ''
  let i = 0

  const flush = (): void => {
    if (text !== '') {
      out.push({ type: 'text', text })
      text = ''
    }
  }

  while (i < src.length) {
    const ch = src[i] ?? ''

    if (ch === '\\' && i + 1 < src.length) {
      text += src[i + 1]
      i += 2
      continue
    }

    if (ch === '`') {
      const run = countRun(src, i, '`')
      const close = src.indexOf('`'.repeat(run), i + run)
      if (close !== -1 && src.slice(close, close + run + 1) !== '`'.repeat(run + 1)) {
        flush()
        out.push({ type: 'code', text: src.slice(i + run, close).trim() })
        i = close + run
        continue
      }
      text += '`'.repeat(run)
      i += run
      continue
    }

    if (ch === '[') {
      const link = matchLink(src, i)
      if (link) {
        flush()
        out.push({ type: 'link', href: link.href, children: parseInline(link.label) })
        i = link.next
        continue
      }
    }

    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const closed = findClosing(src, i + 2, ch.repeat(2))
      if (closed !== -1) {
        flush()
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, closed)) })
        i = closed + 2
        continue
      }
    }

    if (ch === '~' && src[i + 1] === '~') {
      const closed = findClosing(src, i + 2, '~~')
      if (closed !== -1) {
        flush()
        out.push({ type: 'del', children: parseInline(src.slice(i + 2, closed)) })
        i = closed + 2
        continue
      }
    }

    if (ch === '*' || ch === '_') {
      // `snake_case_names` must not become emphasis, so `_` only opens when it is
      // not glued to a word character on its left.
      const prev = src[i - 1] ?? ' '
      const opens = ch === '*' || !/\w/.test(prev)
      const closed = opens ? findClosing(src, i + 1, ch) : -1
      if (closed !== -1 && closed > i + 1) {
        flush()
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, closed)) })
        i = closed + 1
        continue
      }
    }

    text += ch
    i += 1
  }

  flush()
  return out
}

function countRun(src: string, at: number, ch: string): number {
  let n = 0
  while (src[at + n] === ch) n += 1
  return n
}

/** Index of the next unescaped `token`, or -1. Code spans are skipped over. */
function findClosing(src: string, from: number, token: string): number {
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '`') {
      const run = countRun(src, i, '`')
      const close = src.indexOf('`'.repeat(run), i + run)
      if (close === -1) return -1
      i = close + run - 1
      continue
    }
    if (src.startsWith(token, i)) return i
  }
  return -1
}

function matchLink(src: string, at: number): { label: string; href: string; next: number } | null {
  let depth = 0
  let end = -1
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1 || src[end + 1] !== '(') return null
  const close = src.indexOf(')', end + 2)
  if (close === -1) return null
  const target = src.slice(end + 2, close).trim()
  // A title after the URL (`(/x "t")`) is dropped; peek shows no tooltips here.
  const href = target.split(/\s+/)[0] ?? ''
  return { label: src.slice(at + 1, end), href, next: close + 1 }
}
