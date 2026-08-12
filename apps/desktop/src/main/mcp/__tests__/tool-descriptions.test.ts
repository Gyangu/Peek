import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { asPanelId, asSplitId, type WorkspaceSnapshot } from '@peek/core'
import { installPackages } from '../../../drivers/installed'
import { IN_REPO_PACKAGES } from '../../../drivers/__tests__/in-repo-packages'
import { driverManifests } from '../../../drivers/manifests'
import { mcpInstructions } from '../instructions'
import connect from '../tools/connect'
import listConnections from '../tools/list-connections'
import type { ToolContext } from '../types'

/* ==================================================================
 * Three pieces of model-facing text are assembled from the installed packages,
 * and all three are read **after** the modules that produce them were loaded.
 *
 * That ordering is the whole subject of this file, and it is not incidental —
 * it is what production does. `collectBuiltinTools` expands an eager
 * `import.meta.glob`, so every tool module under `tools/` is evaluated while
 * main is still loading its own imports; `~/.peek/packages/` is not scanned
 * until `app.whenReady()`, several steps later. A description built from a
 * module constant is therefore built from an empty registry, and the failure is
 * silent in the worst way: `connect` still works, and the model is simply told
 * that peek can open no databases.
 *
 * The two tools are imported by path rather than through `collectBuiltinTools`,
 * which is a Vite feature (`import.meta.glob`) and not available under
 * `node --test`. What is being measured is the same object either way: the glob
 * collects these very default exports.
 *
 * So this file deliberately does **not** import
 * `drivers/__tests__/in-repo-registry` for its side effect the way the rest of
 * the suite does. It takes the value and installs it inside a test, after the
 * imports above have all run — which is the order main runs in, and the only
 * order in which these assertions mean anything.
 * ================================================================== */

describe('text assembled from the installed packages', () => {
  /*
   * Called per test rather than once at file scope, for the same reason: a
   * module-scope install would happen during this file's own evaluation and put
   * the registry in place before `registry.ts` had finished loading — which is
   * exactly the ordering that must not be assumed.
   */
  function installLate(): void {
    installPackages(IN_REPO_PACKAGES)
  }

  test('the connect tool names every installed driver, not the ones present at import', () => {
    installLate()

    for (const manifest of driverManifests()) {
      assert.ok(
        connect.description.includes(manifest.mcpConnectExample),
        `${manifest.driverId} is installed and its config example is missing from connect's ` +
          'description, so a model has to guess the field names for it',
      )
    }
  })

  test('the empty state of list_connections quotes a driver that exists', async () => {
    installLate()

    // The read path rather than the description: this is the sentence a model is
    // handed when there is nothing to list, and it tells it what to copy. Built
    // from an empty registry it reads `{"config":}` — syntactically broken JSON
    // offered as an example, which is worse than no example at all.
    const out = await listConnections.run({}, emptyWorkspace())
    const first = driverManifests()[0]
    assert.ok(first, 'the fixture registry must not be empty, or this proves nothing')
    assert.ok(out.text.includes('There are no connections yet'), 'the empty branch is the one under test')
    assert.ok(
      out.text.includes(`{"config":${first.mcpConnectExample}}`),
      `the empty state must quote an installed driver; it said: ${out.text.split('\n')[0] ?? ''}`,
    )
  })

  test('the MCP preamble carries every installed driver’s example and skill', () => {
    installLate()
    const text = mcpInstructions()

    for (const manifest of driverManifests()) {
      assert.ok(
        text.includes(manifest.mcpConnectExample),
        `${manifest.driverId} is installed but the preamble does not say how to connect to it`,
      )
      if (manifest.skill === undefined) continue
      assert.ok(
        text.includes(manifest.skill),
        `${manifest.driverId} declares a skill that no model will ever read`,
      )
    }
  })
})

/**
 * A window with nothing connected — the only state `list_connections` reports an
 * example in.
 *
 * Hand-built rather than borrowed from a fixture module: what it has to be is
 * *empty*, and every shared snapshot in this directory is populated because the
 * tools around it need something to act on.
 */
function emptyWorkspace(): ToolContext {
  const snapshot: WorkspaceSnapshot = {
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
  }
  return {
    dispatch: () => {
      throw new Error('a read tool must not dispatch')
    },
    getSnapshot: () => snapshot,
    logger: { log: () => {} },
    now: () => 0,
    sleep: async () => {},
  }
}
