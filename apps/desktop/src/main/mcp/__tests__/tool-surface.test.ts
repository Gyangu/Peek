/**
 * What the embedded agent is *not* given.
 *
 * The MCP tool surface is derived from source — the kernel's files under
 * `tools/`, and each driver package's `src/mcp-tools.ts` — which means the
 * surface grows by somebody adding a declaration, and never by a command being
 * added to the bus. That is the property this file guards, from the one
 * direction that matters: some commands must stay unreachable from a model, and
 * the only reason they are is that nobody declared the tool.
 *
 * **Both sources, not just the kernel's.** A package tool is an ordinary
 * `view.update`-shaped shell over the same bus, so a package could reach
 * `chat.sessions.delete` exactly as easily as a kernel tool could — and until
 * this file scanned `packages/*`, it would have done so with nothing looking.
 * `registeredToolSources` is shared with `verify-chat-security.mjs` so the two
 * cannot come to disagree about what a source is.
 *
 * A source-level check, deliberately. `collectTools` uses `import.meta.glob`,
 * which is a Vite build-time construct and does not exist under the plain node
 * test runner, so the registry cannot be instantiated here. Reading the sources
 * asks the same question of the same source of truth.
 *
 * `verify-chat-security.mjs` covers the other direction against a running server
 * (every tool the endpoint offers was declared in one of these). The two together
 * say: the set is exactly what the sources declare, and the sources exclude these
 * commands.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { test } from 'node:test'

// @ts-expect-error — a plain .mjs helper with no declarations, shared with the
// verify script precisely so that "what counts as a tool source" is stated once.
import { registeredToolSources } from '../../../../scripts/tool-sources.mjs'

/** `…/apps/desktop/src/main/mcp/__tests__` → the workspace root. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../../..')

function toolSources(): { file: string; text: string }[] {
  const paths: string[] = registeredToolSources(REPO_ROOT)
  // Repo-relative, not the basename: every package's module is called
  // `mcp-tools.ts`, and an offender reported by basename alone would not say
  // which package to go and look at.
  return paths.map((path) => ({ file: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') }))
}

/**
 * Commands a model may never reach, and why each one.
 *
 * Not a general "dangerous commands" list — every other destructive thing peek
 * can do (closing a connection, cancelling a query, rewriting the layout) is
 * deliberately available to the agent, because it is visible, reversible, and
 * the point of the loop. These two are different: they act on **stored history**
 * outside the window, where nobody would see it happen.
 */
const FORBIDDEN: { command: string; why: string }[] = [
  {
    command: 'chat.sessions.delete',
    why: 'an agent that can delete conversations can delete the record of what it did',
  },
]

test('the scan covers both kinds of source, or the rules below are vacuous for one of them', () => {
  // The failure this catches is a rule quietly matching nothing: a package tool
  // module that moved, or a `packages/*` scan that stopped resolving, would
  // leave every assertion here passing over the kernel's files alone while a
  // package tool went unexamined.
  const files = toolSources().map((s) => s.file)
  assert.ok(
    files.some((f) => f.startsWith('apps/desktop/')),
    `no kernel tool file was scanned; found: ${files.join(', ')}`,
  )
  assert.ok(
    files.some((f) => f.startsWith('packages/db-')),
    'no driver package tool module was scanned. Either every package stopped contributing tools — ' +
      'in which case say so here, because this file has just gone half-vacuous — or the scan broke.',
  )
  // `@peek/core` has a `src/mcp-tools.ts` too: the contract a tool is *declared
  // in*, which is not a tool source. It was being scanned as one until the glob
  // was narrowed to `db-*`, which meant a `name: 'x',` line anywhere in the
  // frozen contract would have registered as a publishable tool name.
  assert.ok(
    !files.some((f) => f.startsWith('packages/core/')),
    'packages/core is being scanned as a tool source. It declares the contract, not tools.',
  )
})

test('no MCP tool exposes a command that destroys stored conversations', () => {
  const sources = toolSources()
  assert.ok(sources.length > 0, 'the tools directory should not be empty; the check would be vacuous')

  for (const { command, why } of FORBIDDEN) {
    const offenders = sources.filter(({ text }) => text.includes(command)).map(({ file }) => file)
    assert.deepEqual(offenders, [], `${command} must not be reachable from MCP — ${why}`)
  }
})

test('the chat tools an agent does have are the two it needs to take part in a conversation', () => {
  const names = toolSources()
    .map(({ text }) => /^\s*name: '([a-z_]+)',$/m.exec(text)?.[1])
    .filter((name): name is string => name !== undefined)

  // Reading and steering the conversation is the whole point of the embedded
  // loop (PLAN §7): an external client watches and drives the panel through
  // these. Managing the *catalogue* is not part of it.
  assert.ok(names.includes('read_chat'), 'the loop needs a way to read the conversation')
  assert.ok(names.includes('send_chat'), 'and a way to take part in it')
  assert.ok(
    !names.some((n) => n.includes('session')),
    `no tool may address sessions as objects; found: ${names.filter((n) => n.includes('session')).join(', ')}`,
  )
})
