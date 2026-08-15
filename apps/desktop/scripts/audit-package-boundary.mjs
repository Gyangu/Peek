#!/usr/bin/env node
/*
 * ==================================================================
 * The artifact is the truth, again: what main can *load*.
 * ==================================================================
 *
 * Design 2026-08-07 §2.4bis(a) buys exactly one thing — main can call
 * `safeStorage.decryptString` on every stored credential, so no package's code
 * may be loaded there — and acceptance 28 is how we claim to have it. That claim
 * has already been wrong once with every check green (§4quater(a)):
 *
 *     grep expand_node out/main/index.js     → 0     ← reported as "28 passes"
 *     grep -l expand_node out/main/chunks/*  → packages-*.js   ← imported by it
 *
 * The entry file is a list of chunk names. Reading it answers a question nobody
 * asked. So this walks the emitted files the way the process does: from
 * `out/main/index.js`, **recursively** through every relative specifier, chunk
 * to chunk, and greps the closure.
 *
 * ## Why this exists next to the in-build guards
 *
 * `assertMainHoldsNoPackageCode` asks Rollup which modules it put in which
 * chunk, which is the sharper question — module identity survives renaming and a
 * string does not. But it can only ever see the build it is running inside, and
 * since §4quater(d) there are two of them: `electron-vite build` and
 * `electron.vite.package-host.config.ts`. Nothing inside either one can say
 * whether the *pair* came out right. This can, because by then both have written
 * their bytes to disk, and the bytes are what the app loads.
 *
 * ## Why both directions, and why the second one is not a formality
 *
 * "No package code in main" passes trivially when there is no package code —
 * when a rename made the search terms stale, when a build step was skipped, when
 * the host bundle came out empty. An absence-only check reports its own blind
 * spots as success. This repo has paid for that lesson twice: once in §2.10
 * (a partition check that was measuring the wrong isolation) and once in
 * §4quater(a) (the grep above).
 *
 * So the same derived strings are asserted **present** where the code really
 * ships: `out/packages/<id>/contrib.mjs`, which a package host `import()`s off
 * disk at fork time (Phase C, §4quaterdecies). That direction fails when
 * `build-packages.mjs` has emitted a package that can answer nothing, and it
 * doubles as the derivation's own self-test — a rule that stopped producing real
 * strings can no longer report main clean, because it can no longer find them
 * where they certainly are.
 *
 * A 2b runs alongside it and is what Phase C bought: the package **host bundle**
 * must hold none of them either. One `package-host.js` serves every package, so
 * a contribution compiled into it is code every other package's host loads —
 * §2.4bis(a)'s objection to main, one process over.
 *
 * A third assertion runs the other way for the metadata half: every tool *name*
 * a package declares must be present in main. §2.4bis(d) requires `tools/list`
 * to be answerable from the declarations alone, without waking a host, so
 * `expand_node` in `out/main/index.js` is the design working rather than a leak
 * (§4quater(c)) — and it is the positive control proving this walk read
 * something at all.
 *
 * ## How the search terms are derived
 *
 * Never a hard-coded list: that spells "the packages we remembered", and the
 * next package ships unwatched.
 *
 *   1. Start at what a package contributes to the host — the subpaths its own
 *      `contrib.mjs` is built from (`CONTRIBUTION_ENTRIES` below).
 *   2. Follow relative imports inside the package. The closure is the code a
 *      host process runs, `graph.ts` included, which is where the Cypher lives.
 *   3. Split it with `MAIN_MAY_REACH` — the same list the in-build guard uses,
 *      which is why it is a module of its own.
 *   4. A signature is a string literal the host-only half says and nothing that
 *      legitimately reaches main says: not the declarative half, not the
 *      kernel's own sources. A string both sides say cannot tell them apart, so
 *      dropping it costs a signature and can never manufacture one.
 *
 * Step 4 does not always find one. A module can genuinely have no string of its
 * own — `display.ts` assembles its three answers out of template literals and
 * core's helpers — and for those the honest answer is that this check cannot see
 * them and the module-level guard in the build can. `UNSIGNABLE` below is where
 * that is written down, per file, with the reverse check that keeps it from
 * spreading.
 *
 * Literals rather than symbol names, and that is the whole reason step 4 is
 * about strings at all. The bundle is minified; `keepNames` preserves function
 * and class names, and every export these files have is a const object —
 * `neo4jDisplay` greps CLEAN out of a bundle that contains it. Symbol names
 * would be the same false pass one level down.
 *
 * Comments are blanked before literals are read, because a comment is not code:
 * a sentence in a header explaining what a query does would otherwise become a
 * "signature" of that query. `audit-shipped-css.mjs` learned this six times over
 * from the other side, where prose *minted* the class it was warning about.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAIN_MAY_REACH } from './main-may-reach.ts'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '../..')
const outDir = join(desktopDir, 'out')

/**
 * The subpaths a package contributes to a host process.
 *
 * Kept in step with the `contrib.mjs` entry `build-packages.mjs` emits —
 * displays, view kinds, tools — and with the package subpaths
 * `subpath-purity.test.ts` scans. A package that grows a fourth kind of
 * contribution adds it in both places.
 */
const CONTRIBUTION_ENTRIES = ['display.ts', 'mcp-tools.ts', 'view.ts']

/**
 * Sources that are the kernel's, not a package's.
 *
 * Their literals are subtracted from every signature set: whatever these say,
 * main is entitled to say too, so finding it there proves nothing. Renderer and
 * preload are left out on purpose — they are not in main's graph, and widening
 * this only erases signatures.
 */
const KERNEL_SOURCE_DIRS = [
  join(repoRoot, 'packages/core/src'),
  join(desktopDir, 'src/main'),
  join(desktopDir, 'src/drivers'),
]

const mayReachMain = (file) => MAIN_MAY_REACH.some(({ pattern }) => pattern.test(file))

function tsFilesUnder(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // A test's fixtures are not what any process loads.
      if (entry.name !== '__tests__') tsFilesUnder(path, found)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(path)
    }
  }
  return found
}

/* ==================================================================
 * Reading source: literals, with everything that is not code skipped
 * ================================================================== */

/**
 * Where a module specifier follows: `from '…'`, `import '…'`, `import('…')`.
 *
 * Not a string the program says — a name in the build graph, which the bundler
 * resolves away and does not emit. Reading one as a signature would assert that
 * the artifact still contains a path only the source ever had.
 */
const BEFORE_SPECIFIER = /(?:^|[^\w$])(?:from|import|require\()$/

/** Where a `/` starts a regex rather than a division: the code just before it. */
const REGEX_KEYWORDS = 'return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof'
const BEFORE_REGEX = new RegExp(`(?:[([{,;:=!&|?+\\-*%<>~^]|\\b(?:${REGEX_KEYWORDS}))$`)

/** Index just past a quoted run that starts at `open`, honouring backslash escapes. */
function endOfQuoted(source, open, quote) {
  let i = open + 1
  while (i < source.length) {
    const c = source[i]
    if (c === '\\') i += 2
    else if (c === quote) return i + 1
    else i += 1
  }
  return source.length
}

/**
 * Every single- or double-quoted literal in a TypeScript source, as written.
 *
 * Comments, template literals and regex literals are stepped over rather than
 * read: the first is prose, and the other two are shapes the bundler is free to
 * re-spell (a template's static halves can be folded, concatenated or split), so
 * a match on them would say more about esbuild than about the boundary.
 * Literals carrying a backslash are dropped for that same reason — the emitted
 * escape is not necessarily the one that was written.
 */
function literalsOf(source) {
  const found = new Set()
  let i = 0
  let prefix = ''
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '/' && (prefix === '' || BEFORE_REGEX.test(prefix))) {
      i = endOfQuoted(source, i, '/')
      prefix = '/'
      continue
    }
    if (c === '`') {
      i = endOfQuoted(source, i, '`')
      prefix = '`'
      continue
    }
    if (c === "'" || c === '"') {
      const end = endOfQuoted(source, i, c)
      const text = source.slice(i + 1, end - 1)
      if (!text.includes('\\') && !BEFORE_SPECIFIER.test(prefix)) found.add(text)
      i = end
      prefix = c
      continue
    }
    if (!/\s/.test(c)) prefix = (prefix + c).slice(-16)
    i += 1
  }
  return found
}

const sourceCache = new Map()
const sourceOf = (file) => {
  const cached = sourceCache.get(file)
  if (cached !== undefined) return cached
  const text = readFileSync(file, 'utf8')
  sourceCache.set(file, text)
  return text
}

/* ==================================================================
 * Reading source: which files a package's contribution pulls in
 * ================================================================== */

const RELATIVE_IMPORT = /(?:^|[^\w$.])(?:from|import)\s*\(?\s*(['"])(\.[^'"]*)\1/g

function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** The package's own files reachable from `entries`, transitively. */
function intraPackageClosure(entries) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    for (const [, , specifier] of sourceOf(file).matchAll(RELATIVE_IMPORT)) {
      const target = resolveRelative(file, specifier)
      if (target !== undefined) queue.push(target)
    }
  }
  return [...seen]
}

/**
 * The tool names a package declares.
 *
 * Read off `defineToolMeta({ … })` in the package's own source rather than off
 * anything in `apps/`, because the claim being checked is that the *package's*
 * declaration is what main ships — an app-side list would agree with itself.
 * There is no longer one to be tempted by (`PACKAGE_TOOL_META` was it), and the
 * grep stays pointed here so that a new one could not quietly become the oracle.
 */
const TOOL_NAME = /defineToolMeta\(\{[\s\S]*?\bname:\s*(['"])([^'"]+)\1/g

/* ==================================================================
 * Reading the artifact: what a process actually loads
 * ================================================================== */

const EMITTED_IMPORT = /(?:^|[^\w$.])(?:from|import|require)\s*\(?\s*(['"])(\.[^'"]*)\1/g

/**
 * Every emitted file a process started at `entryFile` can load.
 *
 * Recursive, and that recursion is the entire point of acceptance 28: chunks
 * import chunks, and the entry file names nothing but the first hop. Confined to
 * `out/` so a stray specifier cannot walk the check out of the build.
 */
function reachableFrom(entryFile) {
  const seen = new Set()
  const queue = [entryFile]
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file) || !file.startsWith(outDir) || !existsSync(file)) continue
    seen.add(file)
    for (const [, , specifier] of sourceOf(file).matchAll(EMITTED_IMPORT)) {
      queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen]
}

/* ==================================================================
 * Derive
 * ================================================================== */

const packagesDir = join(repoRoot, 'packages')
const packageNames = readdirSync(packagesDir).filter((name) => name.startsWith('db-'))

const kernelLiterals = new Set()
for (const dir of KERNEL_SOURCE_DIRS) {
  for (const file of tsFilesUnder(dir)) {
    for (const literal of literalsOf(sourceOf(file))) kernelLiterals.add(literal)
  }
}

/** A literal short enough to collide with anything is not evidence of anything. */
const MIN_SIGNATURE_LENGTH = 8

/**
 * Host-only modules a byte grep **cannot** see, and why each one.
 *
 * The assertion below says every module that runs in a package host must write
 * at least one string this audit could recognise, and its message offers the two
 * ways out: give the module such a string, or widen the derivation. `display.ts`
 * takes neither, because neither is available — §4sexies(d) has the measurement.
 * Its three functions assemble their answer out of template literals, numeric
 * defaults and core's helpers; the only string literal in the five of them is
 * `'localhost'`, which `src/main/mcp/server.ts` also writes, and the qdrant one
 * writes no string at all. Inventing a marker string for the grep to find would
 * be a signature about nothing.
 *
 * So the honest record is that these are covered by module identity in the build
 * (`assertMainHoldsNoPackageCode`) and by nothing here. Two things keep that from
 * decaying into an excuse:
 *
 *   - a listed module that *does* say something recognisable fails, so the day
 *     one grows a distinctive literal the entry is deleted and the grep takes
 *     over — the list can only ever cover modules it is telling the truth about;
 *   - a pattern matching no host-only module fails, the same self-check
 *     `MAIN_MAY_REACH` carries.
 *
 * It is **not** an entry in `main-may-reach.ts` and must not become one: that
 * list says main may load a file, and main may not load this one.
 */
const UNSIGNABLE = [
  {
    pattern: /\/src\/display\.ts$/,
    why: 'three strings built from templates and core helpers; no literal of its own to grep for',
  },
]

const isUnsignable = (file) => UNSIGNABLE.some(({ pattern }) => pattern.test(file))

/** signature → the package source file that says it */
const signatures = new Map()
/** tool name → the declaration file that names it */
const declaredToolNames = new Map()
const hostOnlyModules = []
const excusedModules = []
const unsignableModules = []
const packagesWithHostCode = new Set()

for (const name of packageNames) {
  const srcDir = join(packagesDir, name, 'src')
  const entries = CONTRIBUTION_ENTRIES.map((f) => join(srcDir, f)).filter((f) => existsSync(f))
  if (entries.length === 0) continue

  const closure = intraPackageClosure(entries)
  const excused = closure.filter((file) => mayReachMain(file))
  const hostOnly = closure.filter((file) => !mayReachMain(file))
  excusedModules.push(...excused)
  hostOnlyModules.push(...hostOnly)
  if (hostOnly.length > 0) packagesWithHostCode.add(name)

  const excusedLiterals = new Set()
  for (const file of excused) {
    for (const literal of literalsOf(sourceOf(file))) excusedLiterals.add(literal)
    for (const [, , toolName] of sourceOf(file).matchAll(TOOL_NAME)) {
      declaredToolNames.set(toolName, file)
    }
  }

  for (const file of hostOnly) {
    const mine = []
    for (const literal of literalsOf(sourceOf(file))) {
      if (literal.length < MIN_SIGNATURE_LENGTH) continue
      if (excusedLiterals.has(literal) || kernelLiterals.has(literal)) continue
      mine.push(literal)
    }

    if (isUnsignable(file)) {
      // The reverse direction of the list: a module listed as invisible that has
      // become visible must leave the list, or the entry starts hiding a check
      // that would now work.
      assert.deepEqual(
        mine,
        [],
        `${relative(repoRoot, file)} is listed in UNSIGNABLE, but it now writes ${String(mine.length)} ` +
          `string(s) only it would write:\n\n` +
          mine.map((literal) => `    ${JSON.stringify(literal)}`).join('\n') +
          `\n\n  That is the whole thing the list says it does not do. Delete its entry and let the grep ` +
          `check it —\n  a module the audit can see is worth more than a module it has an excuse for.\n`,
      )
      unsignableModules.push(file)
      continue
    }

    for (const literal of mine) {
      if (!signatures.has(literal)) signatures.set(literal, file)
    }
    assert.ok(
      mine.length > 0,
      `${relative(repoRoot, file)} runs in a package host and says nothing this audit can recognise ` +
        `in the shipped bundle.\n\n` +
        `  Every string it writes is also written by the kernel or by the declarative half beside it, ` +
        `so if this\n  module were loaded into main, grepping could not tell. The module-level guard in ` +
        `electron.vite.config.ts\n  still covers it; this one has gone quiet about it, and a check that is ` +
        `quiet about a file is the\n  failure mode acceptance 28 was rewritten to avoid.\n\n` +
        `  Either give the module a string only it would write, widen the derivation at the top of ` +
        `this file, or —\n  if neither is possible, as for a module that writes no literals at all — ` +
        `add it to UNSIGNABLE with the reason.\n`,
    )
  }
}

/* ==================================================================
 * Assert
 * ================================================================== */

assert.ok(
  signatures.size > 0,
  'no signatures could be derived from any package, so the boundary check below cannot fail.\n\n' +
    '  Design §2.4bis(d) has packages contributing displays, view kinds and tools, and a host process ' +
    'exists to run\n  them; if that stopped being true, this script is what should be deleted, ' +
    'deliberately. Until then an empty\n  set means the derivation broke — most likely ' +
    'CONTRIBUTION_ENTRIES no longer names the files a package\n  contributes through.\n',
)

const mainEntry = join(outDir, 'main/index.js')
const hostEntry = join(outDir, 'package-host/package-host.js')
for (const [entry, how] of [
  [mainEntry, 'electron-vite build'],
  [hostEntry, 'pnpm build:package-host'],
]) {
  assert.ok(
    existsSync(entry),
    `${relative(desktopDir, entry)} does not exist; run \`${how}\` first. Auditing the boundary ` +
      `between two bundles needs both of them — this script passing on a missing one would be the ` +
      `same vacuous pass it exists to rule out.`,
  )
}

const mainFiles = reachableFrom(mainEntry)
const hostFiles = reachableFrom(hostEntry)

/*
 * Direction 1 — main holds none of the implementation.
 *
 * The whole closure, not the entry: `index.js` was clean in §4quater(a) while
 * the chunk one hop away held the handlers.
 */
const leaks = []
for (const [signature, source] of signatures) {
  for (const file of mainFiles) {
    if (!sourceOf(file).includes(signature)) continue
    leaks.push(
      `${relative(outDir, file)}\n      ${JSON.stringify(signature)}` +
        `\n      from ${relative(repoRoot, source)}`,
    )
  }
}
assert.deepEqual(
  leaks,
  [],
  `the main process can load package implementation code:\n\n` +
    leaks.map((l) => `    ${l}`).join('\n\n') +
    `\n\n  Reached by following imports from out/main/index.js — chunk to chunk, which is how the ` +
    `process reaches\n  it too. Design §2.4bis(a): main decrypts every stored credential, so a package ` +
    `loaded there reads every\n  saved password of every other one. The code belongs in the package ` +
    `host, which loads it from the\n  package's own contrib.mjs off disk — main is meant to hold the ` +
    `declarative half only, and reads that\n  out of peek-package.json.\n`,
)

/*
 * Direction 2 — the built packages hold all of it, and neither bundle does.
 *
 * Since Phase C (§4quaterdecies) the package host bundle is core and one entry
 * file: it `import()`s `<packagesRoot>/<id>/contrib.mjs` at fork time, so the
 * contributions are not compiled into it and asserting they are would now be
 * asserting the arrangement that was removed.
 *
 * Which makes this direction stronger rather than weaker. The old version could
 * only say "it is over there instead"; this one says where the code actually is
 * — a file on disk that ships as data — and that *both* bundles are free of it.
 * The self-test the direction exists for is unchanged and is the first of the
 * two: a derivation that stopped producing real strings can no longer find them
 * where they certainly are, so it can no longer report main clean for free.
 */
const builtPackagesDir = join(outDir, 'packages')
const builtPackageFiles = existsSync(builtPackagesDir)
  ? readdirSync(builtPackagesDir)
      .flatMap((id) => ['contrib.mjs', 'driver.mjs'].map((f) => join(builtPackagesDir, id, f)))
      .filter((file) => existsSync(file))
  : []
assert.ok(
  builtPackageFiles.length > 0,
  `no built packages under ${relative(desktopDir, builtPackagesDir)}; run \`pnpm build:packages\` first. ` +
    `Phase C loads a package's contributions from there, so an empty directory would make the check ` +
    `below vacuous.`,
)

const missing = []
for (const [signature, source] of signatures) {
  if (builtPackageFiles.some((file) => sourceOf(file).includes(signature))) continue
  missing.push(`${JSON.stringify(signature)}\n      from ${relative(repoRoot, source)}`)
}
assert.deepEqual(
  missing,
  [],
  `${String(missing.length)} string(s) that package code writes are absent from every built package ` +
    `under out/packages/ — and, by the check above, from main as well:\n\n` +
    missing.map((m) => `    ${m}`).join('\n\n') +
    `\n\n  Two different bugs land here. Either \`build-packages.mjs\` really did lose the code — a host ` +
    `forked for\n  that package answers NOT_FOUND to everything it is supposed to contribute — or these ` +
    `strings are no\n  longer what the build emits, in which case direction 1 above is now searching for ` +
    `nothing and\n  reporting main clean for free. That second one is why this assertion exists at all.\n`,
)

/*
 * Direction 2b — and the package host bundle holds none of it.
 *
 * What Phase C bought, stated as a check rather than left as a claim: one
 * `package-host.js` is shared by every package, so a contribution compiled into
 * it would be code every *other* package's host also loads — the same "one
 * bundle, five packages" cost §2.4bis(a) forbids main, one process over.
 */
const compiledIn = []
for (const [signature, source] of signatures) {
  for (const file of hostFiles) {
    if (!sourceOf(file).includes(signature)) continue
    compiledIn.push(
      `${relative(outDir, file)}\n      ${JSON.stringify(signature)}` +
        `\n      from ${relative(repoRoot, source)}`,
    )
  }
}
assert.deepEqual(
  compiledIn,
  [],
  `the package host bundle carries package implementation code:\n\n` +
    compiledIn.map((l) => `    ${l}`).join('\n\n') +
    `\n\n  Since Phase C a package host loads its own \`contrib.mjs\` off disk and the bundle is core ` +
    `plus\n  src/main/packages/entry.ts. Anything else in it is a package compiled into the process ` +
    `every other\n  package is forked with.\n`,
)

/*
 * Direction 3 — the declarations are on disk, and main does not carry a copy.
 *
 * **This direction was inverted on 2026-08-11 (§4duodevicies(e)); the original
 * is in acceptance 28 item 3, kept there for contrast.** It used to require
 * every declared tool name to be *in* main's closure, and that was right for as
 * long as `PACKAGE_TOOL_META` was a compile-time constant: the name had to be
 * compiled in or `tools/list` could not answer at all.
 *
 * Since §4duodevicies main answers from `installedTools()` — the manifests under
 * `~/.peek/packages/` — so a tool name in `out/main/index.js` is no longer the
 * design holding. It is a second, compiled-in list of tools that a package being
 * uninstalled cannot move, which is precisely the shape acceptance 13's first
 * sentence failed in (§4sedecies(b)): `expand_node` outlived its package across
 * a fresh session and a restart.
 *
 * The positive control moved with it. "This script really read an artifact" is
 * now answered by finding the names in the built manifests, which is also the
 * stronger claim: it says the list is being read from the right place.
 */
assert.ok(
  declaredToolNames.size > 0,
  'no package declares an MCP tool, so nothing checks that `tools/list` can be answered without ' +
    'waking a host.\n\n  §2.4bis(d) is the reason `mcp-tool-meta.ts` is a separate file at all. If the ' +
    'declaration moved, TOOL_NAME\n  above is looking for the wrong shape.\n',
)

const builtManifests = existsSync(builtPackagesDir)
  ? readdirSync(builtPackagesDir)
      .map((id) => join(builtPackagesDir, id, 'peek-package.json'))
      .filter((file) => existsSync(file))
  : []
const unpublished = [...declaredToolNames]
  .filter(([toolName]) => !builtManifests.some((file) => sourceOf(file).includes(`"${toolName}"`)))
  .map(([toolName, source]) => `${toolName}  (declared in ${relative(repoRoot, source)})`)
assert.deepEqual(
  unpublished,
  [],
  `${String(unpublished.length)} declared tool name(s) reach no built peek-package.json:\n\n` +
    unpublished.map((u) => `    ${u}`).join('\n') +
    `\n\n  §2.4bis(d) requires \`tools/list\` to be answered from the manifest without forking a package ` +
    `host, and\n  §4duodevicies made main read exactly that — so a name the manifest does not carry is a ` +
    `tool nobody can\n  list. Either build-packages.mjs stopped serializing the declarations, or this ` +
    `script is looking at an\n  empty out/packages/, which would make the direction below vacuous.\n`,
)

const compiledIntoMain = [...declaredToolNames]
  .filter(([toolName]) => mainFiles.some((file) => sourceOf(file).includes(toolName)))
  .map(([toolName, source]) => `${toolName}  (declared in ${relative(repoRoot, source)})`)
assert.deepEqual(
  compiledIntoMain,
  [],
  `${String(compiledIntoMain.length)} declared tool name(s) are compiled into main:\n\n` +
    compiledIntoMain.map((u) => `    ${u}`).join('\n') +
    `\n\n  Main answers \`tools/list\` from installedTools() — the manifests on disk — since ` +
    `§4duodevicies. A tool\n  name in main's closure means a second list of tools that no uninstall can ` +
    `move, and that is the exact\n  shape acceptance 13's first sentence failed in: the package was gone ` +
    `from ~/.peek/packages/, the\n  tombstone was written, and the model was still being offered the ` +
    `tool. src/main/mcp/package-tools.ts\n  is where the registry is read; anything importing ` +
    `src/drivers/mcpTools.ts from main puts the old list back.\n`,
)

/*
 * And the list itself: a pattern that excuses no file excuses nothing. It is
 * cheap to notice here, and the alternative is a typo that quietly widens or
 * narrows the boundary the next time somebody copies the entry above it.
 */
const packageSources = packageNames.flatMap((name) => tsFilesUnder(join(packagesDir, name, 'src')))
const stale = MAIN_MAY_REACH.filter(({ pattern }) => !packageSources.some((f) => pattern.test(f))).map(
  ({ pattern, why }) => `${String(pattern)}  — ${why}`,
)
/** The same self-check for the other list, for the same reason. */
const staleUnsignable = UNSIGNABLE.filter(
  ({ pattern }) => !unsignableModules.some((f) => pattern.test(f)),
).map(({ pattern, why }) => `${String(pattern)}  — ${why}`)
assert.deepEqual(
  staleUnsignable,
  [],
  `${String(staleUnsignable.length)} entr(ies) in UNSIGNABLE match no host-only module:\n\n` +
    staleUnsignable.map((s) => `    ${s}`).join('\n') +
    `\n\n  Either the file moved, the pattern has a typo, or the module stopped being host-only — and in ` +
    `that last case\n  it is main-may-reach.ts that has to say so, since the question then is whether ` +
    `main may load it.\n`,
)

assert.deepEqual(
  stale,
  [],
  `${String(stale.length)} entr(ies) in scripts/main-may-reach.ts match no package source file:\n\n` +
    stale.map((s) => `    ${s}`).join('\n') +
    `\n\n  Delete it, or fix the pattern. Both checks that read this list treat an entry as "main is ` +
    `allowed to hold\n  this file", and one that names no file is a sentence about nothing sitting in ` +
    `the middle of the boundary.\n`,
)

/*
 * The unsignable count is printed rather than kept internal on purpose: it is
 * the number of host-only modules this check has nothing to say about, and a
 * check that is quiet about a file is the failure mode acceptance 28 was
 * rewritten to avoid. Reading "of 6 host-only modules, 5 unsignable" is the
 * honest summary — one module carries the whole grep.
 */
const bytesOf = (files) => files.reduce((n, f) => n + Buffer.byteLength(sourceOf(f)), 0)
process.stdout.write(
  `audit-package-boundary: main loads ${String(mainFiles.length)} file(s) / ` +
    `${String(bytesOf(mainFiles))} B and holds none of the ${String(signatures.size)} string(s) derived ` +
    `from ${String(hostOnlyModules.length)} host-only module(s) in ${String(packagesWithHostCode.size)} ` +
    `package(s) (${String(excusedModules.length)} module(s) excused by main-may-reach.ts, ` +
    `${String(unsignableModules.length)} unsignable); the package ` +
    `host loads ${String(hostFiles.length)} file(s) / ${String(bytesOf(hostFiles))} B and holds none of ` +
    `them either; all ${String(signatures.size)} are in the ${String(builtPackageFiles.length)} built ` +
    `package file(s) it loads off disk; ${String(declaredToolNames.size)} declared tool name(s) in ` +
    `${String(builtManifests.length)} built manifest(s) and none in main\n`,
)
