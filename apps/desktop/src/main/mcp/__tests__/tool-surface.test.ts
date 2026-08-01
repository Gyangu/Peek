/**
 * What the embedded agent is *not* given.
 *
 * The MCP tool surface is derived from the files in `tools/` — one file, one
 * tool — which means the surface grows by somebody adding a file, and never by
 * a command being added to the bus. That is the property this file guards, from
 * the one direction that matters: some commands must stay unreachable from a
 * model, and the only reason they are is that nobody wrote the file.
 *
 * A source-level check, deliberately. `collectBuiltinTools` uses
 * `import.meta.glob`, which is a Vite build-time construct and does not exist
 * under the plain node test runner, so the registry cannot be instantiated here.
 * Reading the directory asks the same question of the same source of truth.
 *
 * `verify-chat-security.mjs` covers the other direction against a running server
 * (every tool the endpoint offers corresponds to a file here). The two together
 * say: the set is exactly the files, and the files exclude these commands.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const TOOLS_DIR = fileURLToPath(new URL('../tools', import.meta.url))

function toolSources(): { file: string; text: string }[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({ file, text: readFileSync(join(TOOLS_DIR, file), 'utf8') }))
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
