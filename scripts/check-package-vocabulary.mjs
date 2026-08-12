#!/usr/bin/env node
/* ==================================================================
 * The old word does not describe anything peek ships.
 *
 * Design 2026-08-07 §0.1 renamed the whole mechanism to **database package**,
 * and acceptance 27 states the invariant this file enforces: a repo-wide
 * case-insensitive search for the old word may only find
 *
 *   1. `docs/design/2026-08-03-…-architecture.md` — the 2026-08-03 record,
 *      deliberately not renamed, plus references to it by name;
 *   2. §0.1 of the design above — the old→new table, which has to spell the old
 *      words to be a table;
 *   3. a third-party tool's own vocabulary (vite, rollup, esbuild, babel,
 *      tailwind, immer), which is not ours to rename.
 *
 * The third class is the reason this is a script and not `grep | wc -l`. It is
 * kept as a per-file list of **literal** spellings rather than a pattern like
 * "any line mentioning vite", because a pattern is a hole: a peek identifier
 * that happened to share a line with the word `vite` would pass. Every entry
 * must still match something (see `unusedAllowances` below), so the list cannot
 * quietly grow into one.
 *
 * The word itself is assembled from `OLD` and never written out, so this is the
 * one file a careless repo-wide search-and-replace cannot rewrite — a guard that
 * renames itself along with the thing it guards has stopped guarding anything.
 *
 * Run standalone (`node scripts/check-package-vocabulary.mjs`) or as the first
 * step of `pnpm test`.
 * ================================================================== */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const OLD = 'plu' + 'gin'
const OLD_CAP = 'Plu' + 'gin'
const OLD_RE = new RegExp(OLD, 'i')

/** The 2026-08-03 record. Not renamed: rewriting it would falsify it. */
const HISTORY_DOC = `docs/design/2026-08-03-${OLD}-architecture.md`

/** Its short name, which comments and other designs cite instead of the path. */
const HISTORY_REF = `${OLD}-architecture`

/** The design that did the renaming; §0.1 of it carries the old→new table. */
const RENAME_DOC = 'docs/design/2026-08-07-database-packages-from-disk.md'

const SELF = 'scripts/check-package-vocabulary.mjs'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.turbo',
  '.vite',
  'coverage',
  'out',
  'dist',
  'build',
  'release',
])

/** Binary-ish payloads a text search would only produce noise from. */
const SKIP_EXT = /\.(png|jpe?g|gif|webp|icns|ico|woff2?|ttf|otf|eot|pdf|zip|gz|db|sqlite|tsbuildinfo)$/i

/**
 * Third-party vocabulary, per file, as literal spellings.
 *
 * A line is cleared by removing every literal listed for its file and then
 * re-checking the leftover. A vite config line passes on the strength of its
 * option key; a peek identifier smuggled onto that same line does not, because
 * what gets searched is whatever the allowances could not explain.
 */
const ALLOWED = {
  'pnpm-lock.yaml': [
    `@vitejs/${OLD}-react`,
    `@babel/${OLD}-`,
    `@babel/helper-${OLD}-utils`,
    `@rolldown/${OLD}utils`,
  ],
  'apps/desktop/package.json': [`@vitejs/${OLD}-react`],
  'apps/desktop/electron.vite.config.ts': [
    `@vitejs/${OLD}-react`,
    `@rollup/${OLD}-alias`,
    `externalizeDeps${OLD_CAP}`,
    `cjsShimAtTop${OLD_CAP}`,
    `type { ${OLD_CAP}, Rollup }`,
    `): ${OLD_CAP} {`,
    `${OLD}s: [`,
    `rollup ${OLD}`,
    `vite ${OLD}`,
    `tailwind ${OLD}`,
  ],
  'apps/desktop/scripts/build-packages.mjs': [
    `cjsShimAtTop${OLD_CAP}`,
    `rollup ${OLD}`,
    `vite ${OLD}`,
    `outFile, ${OLD}s)`,
    `    ${OLD}s,`,
  ],
  'apps/desktop/scripts/render-probe/build-page.mjs': [`@vitejs/${OLD}-react`, `${OLD}s: [`],
  'apps/desktop/scripts/stage-node-modules.mjs': [`externalizeDeps${OLD_CAP}`],
  // immer calls `enablePatches()` one of these; both stores say so at the call site.
  'apps/desktop/src/main/store/workspace-store.ts': [`immer's patch ${OLD}`],
  'apps/desktop/src/renderer/state/workspaceStore.ts': [`immer's patch support is a ${OLD}`],
  'docs/design/2026-08-03-driver-package-boundary.md': [`@rollup/${OLD}-alias`],
  'docs/design/2026-08-04-tailwind-migration.md': [`renderer.${OLD}s: [`, `tailwind 的 \`${OLD}()\``],
}

/**
 * The §0.1 line range of `RENAME_DOC`, found by heading rather than pinned to
 * line numbers: the doc is still being edited, and a stale range would either
 * exempt the wrong lines or start failing on an edit that changed nothing.
 */
function renameTableRange(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### 0.1 '))
  if (start === -1) {
    throw new Error(`${RENAME_DOC} no longer has a "### 0.1 " heading, so the rename table cannot be found.`)
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('## ') || line.startsWith('### ')) {
      end = i
      break
    }
  }
  return { start, end }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(join(dir, entry.name))
    } else if (entry.isFile() && !SKIP_EXT.test(entry.name)) {
      yield join(dir, entry.name)
    }
  }
}

const violations = []
const usedAllowances = new Set()

for (const absolute of walk(repoRoot)) {
  const path = relative(repoRoot, absolute).split(sep).join('/')
  if (path === HISTORY_DOC || path === SELF) continue
  if (statSync(absolute).size > 8 * 1024 * 1024) continue

  const text = readFileSync(absolute, 'utf8')
  if (!OLD_RE.test(text)) continue

  const allowances = ALLOWED[path] ?? []
  const exempt = path === RENAME_DOC ? renameTableRange(text) : null

  text.split('\n').forEach((line, index) => {
    if (!OLD_RE.test(line)) return
    if (exempt !== null && index >= exempt.start && index < exempt.end) return

    // A reference to the 2026-08-03 record, by path or by short name, is a
    // pointer at exemption 1 rather than a leftover.
    let rest = line.split(HISTORY_REF).join('')
    // Outside §0.1 the design still discusses the rename itself (decision 5,
    // §3.5, acceptance 27). Those lines cite §0.1, which is what makes them
    // pointers at exemption 2 rather than misses.
    if (path === RENAME_DOC && rest.includes('§0.1')) return
    for (const allowance of allowances) {
      if (!rest.includes(allowance)) continue
      usedAllowances.add(`${path} ${allowance}`)
      rest = rest.split(allowance).join('')
    }
    if (!OLD_RE.test(rest)) return

    violations.push({ path, line: index + 1, text: line.trim() })
  })
}

const unusedAllowances = []
for (const [path, allowances] of Object.entries(ALLOWED)) {
  for (const allowance of allowances) {
    if (!usedAllowances.has(`${path} ${allowance}`)) unusedAllowances.push(`${path}: ${allowance}`)
  }
}

let failed = false

if (violations.length > 0) {
  failed = true
  console.error(
    `peek calls them database packages (design 2026-08-07 §0.1, acceptance 27).\n` +
      `${String(violations.length)} leftover mention${violations.length === 1 ? '' : 's'} of the old word:\n`,
  )
  for (const v of violations) console.error(`  ${v.path}:${String(v.line)}  ${v.text}`)
  console.error(
    `\nRename it. The only mentions that may stay are ${HISTORY_DOC},\n` +
      `references to it by name, §0.1 of ${RENAME_DOC},\n` +
      `and a third-party tool's own vocabulary — the last listed literally in ${SELF}.`,
  )
}

if (unusedAllowances.length > 0) {
  failed = true
  console.error(
    `\n${String(unusedAllowances.length)} allowance${unusedAllowances.length === 1 ? '' : 's'} in ` +
      `${SELF} ${unusedAllowances.length === 1 ? 'matches' : 'match'} nothing any more.\n` +
      `Delete them — an allowance that guards no line is a hole waiting for the\n` +
      `next line that happens to fit it:\n`,
  )
  for (const a of unusedAllowances) console.error(`  ${a}`)
}

if (failed) process.exit(1)
console.log('[peek/vocabulary] the old word survives only where the design says it may.')
