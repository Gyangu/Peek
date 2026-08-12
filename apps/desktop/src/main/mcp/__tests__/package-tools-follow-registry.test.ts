import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { asPanelId, asSplitId, type InstalledPackages, type InstalledTool } from '@peek/core'
import { clearInstalledPackages, installPackages } from '../../../drivers/installed'
import { IN_REPO_PACKAGES } from '../../../drivers/__tests__/in-repo-packages'
import { packageTools } from '../package-tools'

/* ==================================================================
 * The tool list is a reading of what is installed, not of what was compiled.
 *
 * **This file is the carrier for the first sentence of acceptance 13** —
 * "uninstalling a package leaves no route to it" — measured false in
 * §4sedecies(b) and answered by the decision in §4duodevicies: uninstall
 * `neo4j` and `expand_node` stayed in `tools/list`, in that session, in a fresh
 * one, and across a restart with the directory gone and a tombstone written.
 * Calling it refused, so nothing pretended to work; the model was simply being
 * offered a tool for a database peek could no longer reach.
 *
 * The cause was one line: `packageTools` mapped `PACKAGE_TOOL_META` — an array
 * assembled from compile-time imports — rather than `installedTools()`. So the
 * test that has to go red when the gate is removed is the second one below:
 * point that function back at any compiled-in list and "a registry without the
 * package offers none of its tools" is the assertion that cannot hold.
 *
 * ## Why `null` is passed as the caller everywhere here
 *
 * A `PackageToolCaller` is how a call reaches a host, and none of these tests
 * calls anything — they ask what is *listed*. Passing null also states the
 * asymmetry §2.4bis(d) is built on: with no host reachable at all the tools
 * still list, because listing reads the manifest and forks nothing.
 * `package-tool-routing.test.ts` is the file that exercises a real call.
 * ================================================================== */

/** A registry holding exactly these tools, and no drivers or view kinds. */
function registryOf(tools: readonly InstalledTool[]): InstalledPackages {
  return { drivers: [], viewKinds: [], tools }
}

/** The `expand_node` declaration as the loader would have parsed it off disk. */
function expandNodeDeclaration(): InstalledTool {
  const declared = IN_REPO_PACKAGES.tools.find((tool) => tool.name === 'expand_node')
  assert.ok(declared, 'db-neo4j is the package in this repository that declares an MCP tool')
  return declared
}

afterEach(() => {
  clearInstalledPackages()
})

describe('the package tools main offers', () => {
  test('are the ones the installed manifests declare', () => {
    installPackages(IN_REPO_PACKAGES)

    assert.deepEqual(
      packageTools(null).map((tool) => tool.name),
      ['expand_node'],
    )
  })

  test('a registry without the package offers none of its tools', () => {
    installPackages(IN_REPO_PACKAGES)
    const before = packageTools(null).map((tool) => tool.name)

    // What `packages.uninstall` leaves behind: the loader re-scans and the
    // package is simply not in the report any more (`installPackages` replaces
    // rather than merges, `drivers/installed.ts`).
    installPackages({
      ...IN_REPO_PACKAGES,
      tools: IN_REPO_PACKAGES.tools.filter((tool) => tool.packageId !== 'neo4j'),
    })

    assert.deepEqual(before, ['expand_node'])
    assert.deepEqual(packageTools(null).map((tool) => tool.name), [])
  })

  test('nothing installed means no package tools, not a compiled-in fallback', () => {
    // The state a build that forgot to install is in, and the state main is in
    // before `installAndReportPackages` runs. An answer here that named a tool
    // would be a list that outlived the disk.
    assert.deepEqual(packageTools(null), [])
  })

  test('a tool arriving with a package is offered without a rebuild', () => {
    installPackages(registryOf([]))
    const before = packageTools(null).map((tool) => tool.name)

    installPackages(registryOf([expandNodeDeclaration()]))

    assert.deepEqual(before, [])
    assert.deepEqual(packageTools(null).map((tool) => tool.name), ['expand_node'])
  })
})

describe('what the manifest carries is what the tool is built from', () => {
  test('title and annotations reach the registration, so a model sees the hints', () => {
    installPackages(registryOf([expandNodeDeclaration()]))
    const tool = packageTools(null)[0]

    // §4duodevicies(a): these are the two fields that rule out fetching the
    // execution half from the host at first fork. A `destructiveHint` that
    // arrives after the model has chosen to call is not a hint.
    assert.equal(tool?.title, 'Expand a Neo4j graph node')
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
  })

  test('`kind` picks the constructor, and a read tool never reaches the bus', async () => {
    const declared = expandNodeDeclaration()
    installPackages(
      registryOf([
        { ...declared, kind: 'read', hasRenderer: undefined, name: 'peek_at', packageId: 'sample' } as InstalledTool,
      ]),
    )
    const tool = packageTools(null)[0]

    assert.equal(tool?.name, 'peek_at')
    // `readOnly` is what `defineReadTool` sets and `defineCommandTool` does not,
    // so it is the observable difference between the two constructors — and the
    // reason `kind` had to go onto disk rather than be guessed.
    assert.equal(tool?.readOnly, true)
  })

  test('the JSON Schema on disk becomes the validator a call is checked against', async () => {
    installPackages(registryOf([expandNodeDeclaration()]))
    const tool = packageTools(null)[0]
    assert.ok(tool)

    // With no caller, a *valid* input fails at the host and an *invalid* one
    // fails before that — which is how this tells the two apart without a host.
    const bad = await tool.run({ viewId: '', nodeId: 'x' }, ctx())
    assert.equal(bad.isError, true)
    assert.match(bad.text, /BAD_REQUEST/)

    const good = await tool.run({ viewId: 'view_1', nodeId: '4:abc:12' }, ctx())
    assert.equal(good.isError, true)
    assert.match(good.text, /no package host is available/)
  })

  test('a declaration whose schema cannot become a validator is skipped, not fatal', () => {
    const declared = expandNodeDeclaration()
    installPackages(
      registryOf([
        declared,
        // Unreachable through the loader — `PackageManifestSchema` runs the same
        // conversion and refuses the package by name — but the alternative here
        // is a throw on the path that opens an MCP session, which would cost the
        // kernel's thirteen tools as well as this one.
        { ...declared, name: 'broken', inputSchema: { type: 'object', properties: { a: { type: 'nonsense' } } } },
      ]),
    )

    assert.deepEqual(packageTools(null).map((tool) => tool.name), ['expand_node'])
  })
})

/** The least a `run` needs; nothing here reaches the bus. */
function ctx(): Parameters<ReturnType<typeof packageTools>[number]['run']>[1] {
  return {
    dispatch: async () => {
      throw new Error('no tool in this file reaches the bus')
    },
    getSnapshot: () => ({
      rev: 1,
      layout: {
        type: 'split',
        id: asSplitId('split_1'),
        dir: 'row',
        ratio: [1],
        children: [{ type: 'panel', id: asPanelId('panel_a'), viewIds: [], activeViewId: null }],
      },
      focusedPanel: asPanelId('panel_a'),
      connections: [],
      views: [],
      results: [],
    }),
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }
}
