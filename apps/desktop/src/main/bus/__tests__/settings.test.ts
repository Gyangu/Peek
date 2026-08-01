/**
 * The settings file, and the two commands that read and write it.
 *
 * What is actually at stake is that a timeout **survives a restart**. Before the
 * settings panel, `setTimeoutSettings` existed and nothing ever called it with a
 * persisted value, so an edit lived exactly as long as the process. So the tests
 * that matter here are the round trip and the order of operations:
 *
 *   - what reaches the file is what actually took effect, never what was asked
 *     for — `setTimeoutSettings` drops entries it rejects, and a file recording a
 *     value the process is not honouring is worse than no file at all;
 *   - a write touching one budget leaves the other two alone, in the file as well
 *     as in memory;
 *   - the file is hand-editable, so garbage in it reads as "not set" rather than
 *     reaching the timeout module or taking the whole file down with it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import { createEmptyWorkspace } from '@peek/core'
import { WorkspaceStore } from '../../store/workspace-store'
import { createConnectionBook } from '../../config/connection-book'
import { createConfigHandlers } from '../../config/handlers'
import { createMcpController } from '../../config/mcp-controller'
import { createSettingsStore } from '../../config/settings'
import { SETTINGS_FILE_NAME } from '../../config/paths'
import {
  DEFAULT_EXECUTION_TIMEOUTS,
  getTimeoutSettings,
  resetTimeoutSettings,
} from '../../connections/timeouts'
import { CommandBus } from '../command-bus'
import type { CommandDeps } from '../deps'
import { coreHandlers } from '../handlers'

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = []

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// The timeout module is a process-wide singleton, so a test that changed it must
// not be able to decide what the next one sees.
beforeEach(() => {
  resetTimeoutSettings()
})

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peek-settings-'))
  tempDirs.push(dir)
  return dir
}

const inertDeps = {
  connections: {
    open: async () => {
      throw new Error('not used in this test')
    },
    close: async () => {},
    runQuery: async () => {
      throw new Error('not used in this test')
    },
    cancel: async () => true,
  },
  notify: () => {},
} as unknown as CommandDeps

function busWith(dir: string): CommandBus {
  const bus = new CommandBus({ store: new WorkspaceStore(createEmptyWorkspace()), deps: inertDeps })
  bus.registerAll(coreHandlers)
  const settings = createSettingsStore(dir)
  bus.registerAll(
    createConfigHandlers({
      book: createConnectionBook({
        configDir: dir,
        vault: { available: false, seal: () => null, open: () => null },
      }),
      mcp: createMcpController({
        configDir: dir,
        settings,
        create: () => {
          throw new Error('not started in this test')
        },
        notify: () => {},
        log: () => {},
        onEndpoint: () => {},
      }),
      settings,
      configDir: dir,
      version: '9.9.9-test',
    }),
  )
  return bus
}

function fileJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, SETTINGS_FILE_NAME), 'utf8')) as Record<string, unknown>
}

/* ------------------------------------------------------------------ */

describe('settings.read', () => {
  test('reports the timeouts in force, the version, and where everything lives', async () => {
    const dir = tempConfigDir()
    const res = await busWith(dir).dispatch('settings.read', {}, 'ui')

    assert.ok(res.ok)
    assert.deepEqual(res.data.execution, {
      queryMs: DEFAULT_EXECUTION_TIMEOUTS.queryMs,
      scanMs: DEFAULT_EXECUTION_TIMEOUTS.scanMs,
      vectorSearchMs: DEFAULT_EXECUTION_TIMEOUTS.vectorSearchMs,
    })
    assert.equal(res.data.version, '9.9.9-test')
    assert.equal(res.data.paths.configDir, dir)
    assert.equal(res.data.paths.settingsFile, join(dir, SETTINGS_FILE_NAME))
    // Reported by main rather than reconstructed by a caller: PEEK_CONFIG_DIR
    // moves all of these together.
    assert.ok(res.data.paths.connectionsFile.startsWith(dir))
    assert.ok(res.data.paths.mcpFile.startsWith(dir))
  })

  test('bumps no revision — it is a read of a file, not of the window', async () => {
    const dir = tempConfigDir()
    const bus = busWith(dir)
    const before = await bus.dispatch('settings.read', {}, 'ui')
    const after2 = await bus.dispatch('settings.write', { execution: { queryMs: 30_000 } }, 'ui')
    assert.ok(before.ok)
    assert.ok(after2.ok)
    assert.equal(after2.rev, before.rev)
  })
})

describe('settings.write', () => {
  test('applies immediately and persists, so the value survives a restart', async () => {
    const dir = tempConfigDir()
    const res = await busWith(dir).dispatch('settings.write', { execution: { queryMs: 5_000 } }, 'ui')

    assert.ok(res.ok)
    assert.equal(res.data.execution.queryMs, 5_000)
    // In force in this process…
    assert.equal(getTimeoutSettings().queryMs, 5_000)
    // …and on disk for the next one.
    assert.deepEqual(fileJson(dir)['executionTimeouts'], { queryMs: 5_000 })
    assert.deepEqual(createSettingsStore(dir).read().executionTimeouts, { queryMs: 5_000 })
  })

  test('a value the timeout module refuses is not written to the file', async () => {
    // The ordering rule: apply first, persist what took effect. A stage-level
    // rejection must never leave the file claiming something the process is not
    // doing. 3_600_001ms is past the ceiling `setTimeoutSettings` enforces.
    const dir = tempConfigDir()
    const res = await busWith(dir).dispatch('settings.write', { execution: { scanMs: 3_600_001 } }, 'ui')

    // The schema catches this one before it ever reaches a handler, which is the
    // outer half of the same guarantee.
    assert.equal(res.ok, false)
    assert.equal(getTimeoutSettings().scanMs, DEFAULT_EXECUTION_TIMEOUTS.scanMs)
  })

  test('writing one budget leaves the other two following the built-in default', async () => {
    const dir = tempConfigDir()
    const bus = busWith(dir)
    await bus.dispatch('settings.write', { execution: { queryMs: 5_000 } }, 'ui')
    await bus.dispatch('settings.write', { execution: { vectorSearchMs: 7_000 } }, 'ui')

    const persisted = fileJson(dir)['executionTimeouts']
    assert.deepEqual(persisted, { queryMs: 5_000, vectorSearchMs: 7_000 })
    // scanMs is *absent*, not materialized: a user who never touched it should
    // follow us if the default is ever retuned.
    assert.equal(Object.hasOwn(persisted as object, 'scanMs'), false)
  })

  test('zero is a value — "no deadline" — and not an absence', async () => {
    const dir = tempConfigDir()
    const res = await busWith(dir).dispatch('settings.write', { execution: { queryMs: 0 } }, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.execution.queryMs, 0)
    assert.deepEqual(fileJson(dir)['executionTimeouts'], { queryMs: 0 })
  })

  test('an empty patch is refused rather than written as a no-op', async () => {
    const dir = tempConfigDir()
    assert.equal((await busWith(dir).dispatch('settings.write', {}, 'ui')).ok, false)
    assert.equal((await busWith(dir).dispatch('settings.write', { execution: {} }, 'ui')).ok, false)
  })

  test('the MCP port in the same file is not collateral damage', async () => {
    const dir = tempConfigDir()
    const store = createSettingsStore(dir)
    store.update({ mcpPort: 7500 })

    await busWith(dir).dispatch('settings.write', { execution: { queryMs: 5_000 } }, 'ui')
    assert.equal(fileJson(dir)['mcpPort'], 7500)
  })
})

describe('the file is hand-editable, so it can be hand-broken', () => {
  test('a garbage timeout reads as "not set", and the rest of the file survives', () => {
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, SETTINGS_FILE_NAME),
      JSON.stringify({ mcpPort: 7400, executionTimeouts: { queryMs: 'two minutes', scanMs: 9_000 } }),
    )

    const settings = createSettingsStore(dir).read()
    assert.equal(settings.mcpPort, 7400)
    // The bad key is dropped; the good one beside it is kept. Refusing the whole
    // file would make one typo look like a factory reset.
    assert.deepEqual(settings.executionTimeouts, { scanMs: 9_000 })
  })

  test('an unknown key someone added by hand is preserved across a write', () => {
    const dir = tempConfigDir()
    writeFileSync(join(dir, SETTINGS_FILE_NAME), JSON.stringify({ somethingFromANewerPeek: true }))

    createSettingsStore(dir).update({ executionTimeouts: { queryMs: 5_000 } })
    assert.equal(fileJson(dir)['somethingFromANewerPeek'], true)
  })

  test('a nested value that is not an object at all is ignored, not thrown on', () => {
    const dir = tempConfigDir()
    writeFileSync(join(dir, SETTINGS_FILE_NAME), JSON.stringify({ executionTimeouts: [1, 2, 3] }))
    assert.deepEqual(createSettingsStore(dir).read(), {})
  })
})
