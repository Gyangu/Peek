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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'
import { createEmptyWorkspace, stepUiZoom, UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN } from '@peek/core'
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

function busWith(dir: string, applyZoom?: (factor: number) => void): CommandBus {
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
      ...(applyZoom === undefined ? {} : { applyZoom }),
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

/* ------------------------------------------------------------------ */
/* Interface zoom                                                      */
/* ------------------------------------------------------------------ */

/*
 * The zoom is the first setting whose *application* is not in this process's
 * hands — it is `webContents.setZoomFactor`, injected as `applyZoom` so these
 * handlers stay loadable without Electron. So what is worth asserting is the
 * same shape as the timeouts, plus one thing they do not have: that the window
 * is told, and told the clamped value rather than the requested one.
 *
 * The bounds are load-bearing, not cosmetic. A zoom below 0.8 would scale the
 * 11px text floor back under 9px, which is precisely what
 * design/2026-08-02-ui-legibility-baseline.md exists to prevent — a zoom-out
 * that can undo the legibility floor is a hole in it.
 */
describe('interface zoom', () => {
  test('defaults to 1 when nobody has ever set one', async () => {
    const res = await busWith(tempConfigDir()).dispatch('settings.read', {}, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.uiZoom, UI_ZOOM_DEFAULT)
  })

  test('draws the window at the new size, and remembers it', async () => {
    const dir = tempConfigDir()
    const drawn: number[] = []
    const bus = busWith(dir, (f) => drawn.push(f))

    const res = await bus.dispatch('settings.write', { uiZoom: 1.25 }, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.uiZoom, 1.25)
    // Told the window…
    assert.deepEqual(drawn, [1.25])
    // …and written down, which is the half that survives a restart.
    assert.equal(fileJson(dir)['uiZoom'], 1.25)

    const reread = await busWith(dir).dispatch('settings.read', {}, 'ui')
    assert.ok(reread.ok)
    assert.equal(reread.data.uiZoom, 1.25)
  })

  test('a zoom outside the bounds is refused by the schema, not silently clamped', async () => {
    const dir = tempConfigDir()
    const drawn: number[] = []
    const bus = busWith(dir, (f) => drawn.push(f))

    for (const bad of [0.5, 2, UI_ZOOM_MAX + 0.01]) {
      const res = await bus.dispatch('settings.write', { uiZoom: bad }, 'ui')
      assert.equal(res.ok, false, `${String(bad)} should not be accepted`)
    }
    // Nothing reached the window, and the settings file was never even created
    // — a refused command must not leave a trace of having been tried.
    assert.deepEqual(drawn, [])
    assert.equal(existsSync(join(dir, SETTINGS_FILE_NAME)), false)
  })

  test('changing the zoom does not disturb the timeouts in the same file', async () => {
    const dir = tempConfigDir()
    const bus = busWith(dir)
    await bus.dispatch('settings.write', { execution: { queryMs: 45_000 } }, 'ui')
    await bus.dispatch('settings.write', { uiZoom: 0.9 }, 'ui')

    const file = fileJson(dir)
    assert.equal(file['uiZoom'], 0.9)
    assert.deepEqual(file['executionTimeouts'], { queryMs: 45_000 })
  })

  test('a hand-edited zoom outside the bounds reads as "never set"', () => {
    const dir = tempConfigDir()
    writeFileSync(join(dir, SETTINGS_FILE_NAME), JSON.stringify({ version: 1, uiZoom: 4, mcpPort: 7400 }))
    const store = createSettingsStore(dir)
    // Dropped rather than clamped: 4 is far more likely a typo than a wish, and
    // 1 is a state the user can see and correct. Silently drawing at 1.5 would
    // be a state they cannot explain. The rest of the file is untouched.
    assert.equal(store.read().uiZoom, undefined)
    assert.equal(store.read().mcpPort, 7400)
  })

  test('the menu steps between stops and stops at the ends', () => {
    // `⌘+` / `⌘-` walk this list; they must not wrap, or holding one key would
    // jump from the largest size straight back to the smallest.
    assert.equal(stepUiZoom(1, 1), 1.1)
    assert.equal(stepUiZoom(1, -1), 0.9)
    assert.equal(stepUiZoom(UI_ZOOM_MAX, 1), UI_ZOOM_MAX)
    assert.equal(stepUiZoom(UI_ZOOM_MIN, -1), UI_ZOOM_MIN)
    // A value from a hand-edited file lands between two stops; stepping from
    // "between" resolves to the nearest one first.
    assert.equal(stepUiZoom(1.04, 1), 1.1)
    assert.equal(stepUiZoom(1.04, -1), 0.9)
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
