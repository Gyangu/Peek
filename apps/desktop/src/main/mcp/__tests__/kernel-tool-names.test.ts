import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { KERNEL_TOOL_NAMES, isKernelToolName } from '../kernel-tool-names'
import type { PeekTool } from '../types'

/* ==================================================================
 * `KERNEL_TOOL_NAMES` is a second spelling of what `tools/` declares, and this
 * file is the reason it is allowed to be one.
 *
 * The loader refuses a package that declares a tool name the kernel already
 * owns (design §2.7; `collectTools` in `mcp/registry.ts` is the assertion behind
 * it). It cannot ask the registry: `collectBuiltinTools` expands `import.meta.glob`,
 * which exists only inside a Vite build, and the loader runs during a scan with
 * no server assembled. So it reads a constant — and a constant that drifts is
 * worse than no check at all, because the name it forgets is precisely the one
 * a package would then be free to shadow.
 *
 * The glob is `./tools/*.ts`, so the directory listing is what it expands to;
 * importing each entry gets the very default exports the registry would collect.
 * ================================================================== */

const TOOLS_DIR = fileURLToPath(new URL('../tools/', import.meta.url))

async function declaredToolNames(): Promise<string[]> {
  const files = readdirSync(TOOLS_DIR).filter((name) => name.endsWith('.ts'))
  const names: string[] = []
  for (const file of files) {
    const mod: { default?: PeekTool } = await import(new URL(file, `file://${TOOLS_DIR}`).href)
    const tool = mod.default
    assert.ok(tool, `tools/${file} must default-export a PeekTool`)
    names.push(tool.name)
  }
  return names.sort()
}

test('the list the loader compares against is exactly what tools/ declares', async () => {
  const declared = await declaredToolNames()
  assert.deepEqual(
    [...KERNEL_TOOL_NAMES].sort(),
    declared,
    'KERNEL_TOOL_NAMES has drifted from tools/: a name missing here is a name a package may shadow, ' +
      'and `collectTools` throws on the duplicate long after the package was accepted',
  )
})

test('every one of them answers to isKernelToolName, and an ordinary package name does not', async () => {
  for (const name of await declaredToolNames()) {
    assert.equal(isKernelToolName(name), true, name)
  }
  // The name db-neo4j ships, as the negative case that has to keep loading.
  assert.equal(isKernelToolName('expand_node'), false)
})
