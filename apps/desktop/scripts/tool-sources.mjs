import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where an MCP tool is allowed to come from — the *registered sources*.
 *
 * ## Why this is a list now, and what got weaker
 *
 * `verify-chat-security.mjs`'s headline assertion used to read: every tool name
 * the running server offers corresponds to a file in `src/main/mcp/tools/`. It
 * was derived rather than counted, which is what made it a security check rather
 * than a fixture, and a tool appearing on the wire without a source file in this
 * repository was the finding worth failing the whole script on.
 *
 * A driver package contributes tools now (design §2.4bis), so that assertion is
 * false by construction and had to become: every tool name comes from a
 * **registered source**. The honest accounting of what changed:
 *
 *  - **In Phase B, nothing.** Both sources are directories in this repository,
 *    compiled into the same build. The set of names is exactly as pinned as it
 *    was; it is merely spelled in two places.
 *  - **In Phase C, a lot.** The second source becomes `~/.peek/packages/`, and
 *    "registered" comes to mean "the user installed it". The trust root goes from
 *    *this repository* to *this repository plus whatever the user put in a
 *    directory*, with no signature, manifest check or sandbox in between
 *    (decision 1, §2.7). That is not a weakness in this file — it is the price of
 *    packages, and this comment exists so that nobody has to rediscover it by
 *    reading a green check.
 *
 * Shared by the script and by `mcp/__tests__/tool-surface.test.ts` so the two
 * cannot disagree about what counts as a source. The test asks "do these sources
 * exclude the forbidden commands"; the script asks "is the wire a subset of these
 * sources". Both questions are worthless if each side has its own list.
 */

/**
 * The kernel's own tools: one file, one tool, under `main/mcp/tools/`.
 *
 * @param {string} repoRoot
 */
function kernelToolFiles(repoRoot) {
  const dir = join(repoRoot, 'apps', 'desktop', 'src', 'main', 'mcp', 'tools')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(dir, f))
}

/**
 * Each **driver** package's tool module, at the fixed subpath `src/mcp-tools.ts`.
 *
 * Discovered by looking, not by a hand-kept list: a package that adds the file
 * is registered by having it, which is the same rule `main/mcp/tools/` follows
 * and the same rule `~/.peek/packages/` will follow. A hand-kept list here would
 * be a third place to forget.
 *
 * **`db-` prefixed only, and that word is doing work.** `@peek/core` has a
 * `src/mcp-tools.ts` of its own — the *contract* a tool is declared in, not a
 * tool — and a bare `packages/*` glob swept it up as a source. It declares no
 * name today, so nothing was wrong on the wire; what was wrong is that a
 * `name: 'x',` line landing in the frozen contract for any reason at all would
 * have quietly become a *declared tool name*, and the whole point of this scan
 * is that a name on the wire must correspond to somebody deciding to publish
 * one.
 */
function packageToolFiles(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
  return readdirSync(packagesDir)
    .filter((pkg) => pkg.startsWith('db-'))
    .sort()
    .map((pkg) => join(packagesDir, pkg, 'src', 'mcp-tools.ts'))
    .filter((path) => existsSync(path))
}

/** Every file that may declare an MCP tool, kernel first. */
export function registeredToolSources(repoRoot) {
  return [...kernelToolFiles(repoRoot), ...packageToolFiles(repoRoot)]
}

/**
 * The tool names those sources declare.
 *
 * Reads the declared `name` rather than trusting the filename — `cancel.ts`
 * declares `cancel_query`, and the registry keys off the declaration. Every
 * match in a file counts, because a package module holds its tools in one array
 * rather than one per file.
 */
export function declaredToolNames(repoRoot) {
  const names = []
  for (const path of registeredToolSources(repoRoot)) {
    for (const m of readFileSync(path, 'utf8').matchAll(/^\s*name: '([a-z_]+)',$/gm)) {
      names.push(m[1])
    }
  }
  return names
}
