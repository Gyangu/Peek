#!/usr/bin/env node
/**
 * Checks the claims in `docs/design/2026-08-29-the-documentation-goes-english.md` §5.
 *
 * Four of them are mechanical and live here: no Han characters survive in
 * tracked Markdown, every source comment citing a design record still resolves,
 * every cited section number still exists, and no relative link dangles.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' })
const ls = (p) => git('ls-files', p).split('\n').filter(Boolean)
const HAN = /[一-鿿]/gu
let failed = 0
const report = (name, bad, total, fmt) => {
  if (bad.length === 0) return console.log(`  PASS  ${name} (${total})`)
  failed++
  console.log(`  FAIL  ${name} — ${bad.length} of ${total}`)
  for (const b of bad.slice(0, 12)) console.log(`          ${fmt(b)}`)
  if (bad.length > 12) console.log(`          … ${bad.length - 12} more`)
}

// 1. No Han characters in tracked Markdown.
//    Allowed exception: a line inside a blockquote, which is how a translated
//    document quotes the Chinese clause it replaces.
const md = ls('*.md')
const han = []
for (const f of md) {
  const lines = readFileSync(f, 'utf8').split('\n')
  let fenced = false
  const hits = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => {
      // A fenced block holds code, and code may legitimately carry a Chinese
      // UI string (the renderer ships a zh-CN catalogue). Skip those lines.
      if (/^\s*```/.test(l)) { fenced = !fenced; return false }
      if (fenced) return false
      // A blockquote is how a translated document quotes the clause it replaces.
      if (l.trimStart().startsWith('>')) return false
      HAN.lastIndex = 0
      return HAN.test(l)
    })
  if (hits.length) han.push({ f, n: hits.length, first: hits[0] })
}
report('no Han characters outside blockquotes', han, md.length,
  (b) => `${b.f}:${b.first[0]}  (${b.n} lines)  ${b.first[1].trim().slice(0, 60)}`)

// 2 + 3. Source comments citing a design record resolve, section numbers included.
const SRC = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.css', '*.rs']
const CITE = /(?:docs\/)?design\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md)(?:\s*§\s*([\d.]+))?/g
const missing = []
const badSection = []
let cites = 0
for (const f of ls(...SRC).concat(md)) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(CITE)) {
    cites++
    const target = join('docs/design', m[1])
    if (!existsSync(target)) { missing.push(`${f} → ${m[1]}`); continue }
    if (!m[2]) continue
    // A cited §N.N must exist as a heading number in the target.
    const body = readFileSync(target, 'utf8')
    const heads = new Set([...body.matchAll(/^#{2,6}\s+([\d.]+)/gm)].map((h) => h[1].replace(/\.$/, '')))
    const want = m[2].replace(/\.$/, '')
    // §4 matches heading "4"; §4.4 matches "4.4", or "4" when the doc numbers only top level.
    // A cited §15 is satisfied by `### 15.1` when the document numbers no
    // `## 15` parent, so a prefix match counts.
    const ok = heads.has(want) || [...heads].some((h) => h.startsWith(want + '.'))
    if (!ok) badSection.push(`${f} → ${m[1]} §${m[2]}`)
  }
}
report('design-record citations resolve', missing, cites, (b) => b)
report('cited section numbers exist', badSection, cites, (b) => b)

// 4. Relative Markdown links resolve.
const LINK = /\[[^\]]*\]\((\.{0,2}\/?[^)#\s]+\.md)(?:#[^)\s]*)?\)/g
const dangling = []
let links = 0
for (const f of md) {
  for (const m of readFileSync(f, 'utf8').matchAll(LINK)) {
    links++
    const p = resolve(dirname(f), m[1])
    if (!existsSync(p)) dangling.push(`${f} → ${m[1]}`)
  }
}
report('relative Markdown links resolve', dangling, links, (b) => b)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
