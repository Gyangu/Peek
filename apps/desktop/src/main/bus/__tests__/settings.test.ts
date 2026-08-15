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

/**
 * A vault that seals, for the tests that are about what happens to a secret.
 *
 * The default one below refuses (`seal: () => null`), which is the right default
 * — it is what a Linux box with no keyring does, and every path has to survive
 * it. But "the credential was stored and did not land in the file as plaintext"
 * cannot be checked against a vault that stores nothing, so those tests ask for
 * this one.
 *
 * **It reverses rather than wrapping**, and that is not decoration. The point of
 * those tests is `file.includes(secret) === false`, and a fake seal of
 * `sealed(<value>)` contains the plaintext verbatim — so the assertion fails
 * against a perfectly correct implementation, and the obvious way to make it
 * pass is to weaken it. Ciphertext that does not contain its plaintext is what
 * lets the assertion say what it means.
 */
const workingVault = {
  available: true,
  seal: (value: string) => `sealed:${[...value].reverse().join('')}`,
  open: (value: string) => (value.startsWith('sealed:') ? [...value.slice(7)].reverse().join('') : null),
}

function busWith(
  dir: string,
  applyZoom?: (factor: number) => void,
  vault: { available: boolean; seal: (v: string) => string | null; open: (v: string) => string | null } = {
    available: false,
    seal: () => null,
    open: () => null,
  },
): CommandBus {
  const bus = new CommandBus({ store: new WorkspaceStore(createEmptyWorkspace()), deps: inertDeps })
  bus.registerAll(coreHandlers)
  const settings = createSettingsStore(dir)
  bus.registerAll(
    createConfigHandlers({
      book: createConnectionBook({
        configDir: dir,
        vault: { available: false, seal: () => null, open: () => null },
      }),
      vault,
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

describe('settings.write — keyboard bindings', () => {
  test('persists the record whole, so a reset to default removes the key', async () => {
    // Wholesale, unlike the timeouts next door, and deliberately: a shortcut put
    // back to its default has to *disappear* from the file, which a member-wise
    // merge could never express. The renderer always sends the full record.
    const dir = tempConfigDir()
    const bus = busWith(dir)
    await bus.dispatch('settings.write', { keybindings: { 'panel.close': 'Mod+Alt+KeyQ' } }, 'ui')
    const res = await bus.dispatch('settings.write', { keybindings: { 'tab.close': null } }, 'ui')

    assert.ok(res.ok)
    assert.deepEqual(res.data.keybindings, { 'tab.close': null })
    assert.deepEqual(fileJson(dir)['keybindings'], { 'tab.close': null })
  })

  test('reads back what a restart would read', async () => {
    const dir = tempConfigDir()
    await busWith(dir).dispatch('settings.write', { keybindings: { 'panel.splitRow': 'Mod+Alt+Backslash' } }, 'ui')
    const res = await busWith(dir).dispatch('settings.read', {}, 'ui')

    assert.ok(res.ok)
    assert.deepEqual(res.data.keybindings, { 'panel.splitRow': 'Mod+Alt+Backslash' })
  })

  test('drops a hand-edited entry that is not a chord string, and keeps the rest', async () => {
    // Main does not know what a chord is — the window does — so all it can
    // enforce is the shape. Anything that survives here and is still nonsense is
    // dropped by `buildBindings` in the renderer, one entry at a time.
    const dir = tempConfigDir()
    writeFileSync(
      join(dir, SETTINGS_FILE_NAME),
      JSON.stringify({ version: 1, keybindings: { 'panel.close': 'Mod+KeyQ', 'tab.close': 42 } }),
    )
    const res = await busWith(dir).dispatch('settings.read', {}, 'ui')

    assert.ok(res.ok)
    assert.deepEqual(res.data.keybindings, { 'panel.close': 'Mod+KeyQ' })
  })

  test('is absent entirely when the user changed nothing', async () => {
    const res = await busWith(tempConfigDir()).dispatch('settings.read', {}, 'ui')
    assert.ok(res.ok)
    assert.equal(res.data.keybindings, undefined)
  })
})


/* ------------------------------------------------------------------ */
/* The user's own MCP servers                                          */
/* ------------------------------------------------------------------ */

/** Write an agent patch and return the settings as main now reports them. */
async function writeAgent(
  bus: CommandBus,
  agent: Record<string, unknown>,
): Promise<{ mcpServers: { name: string; target: string; authValueSet: boolean }[] }> {
  const res = await bus.dispatch('settings.write', { agent }, 'ui')
  assert.ok(res.ok, `settings.write failed: ${JSON.stringify(res)}`)
  return res.data.agent
}

test('an MCP credential is sealed on the way in and never comes back', async () => {
  const dir = tempConfigDir()
  const bus = busWith(dir, undefined, workingVault)

  const agent = await writeAgent(bus, {
    mcpServers: [
      { name: 'docs', transport: 'http', target: 'https://example.com/mcp', authValue: 's3cret', enabled: true },
    ],
  })

  // Whether, never what — the same rule the endpoint API key follows.
  assert.equal(agent.mcpServers[0]?.authValueSet, true)
  assert.equal((agent.mcpServers[0] as unknown as Record<string, unknown>)['authValue'], undefined)

  // And the file holds ciphertext under a different key, so anything reading it
  // that has not been taught about `authValueSealed` gets no credential rather
  // than a readable one.
  const raw = JSON.stringify(fileJson(dir))
  assert.equal(raw.includes('s3cret'), false, 'the plaintext credential must not reach the file')
  assert.ok(raw.includes('authValueSealed'), 'and what is there is the sealed field, not a stray key')
})

test('editing a server keeps the credential it did not resend', async () => {
  const dir = tempConfigDir()
  const bus = busWith(dir, undefined, workingVault)
  const server = { name: 'docs', transport: 'http', target: 'https://old/mcp', enabled: true }

  await writeAgent(bus, { mcpServers: [{ ...server, authValue: 's3cret' }] })
  // The form never had the credential to resend — it is write-only — so an edit
  // arrives without one. Reading that as "clear it" would silently break a
  // server that was working, and the failure would surface much later as an
  // authentication error nobody connected to renaming a URL.
  const edited = await writeAgent(bus, { mcpServers: [{ ...server, target: 'https://new/mcp' }] })
  assert.equal(edited.mcpServers[0]?.target, 'https://new/mcp')
  assert.equal(edited.mcpServers[0]?.authValueSet, true)

  // An empty string is the deliberate erase, and it is the only thing that is.
  const cleared = await writeAgent(bus, { mcpServers: [{ ...server, authValue: '' }] })
  assert.equal(cleared.mcpServers[0]?.authValueSet, false)
})

test('the MCP list is replaced wholesale, so a removed server is actually gone', async () => {
  const dir = tempConfigDir()
  const bus = busWith(dir, undefined, workingVault)
  const a = { name: 'a', transport: 'http', target: 'https://a/mcp', enabled: true }
  const b = { name: 'b', transport: 'stdio', target: '/bin/b', enabled: false }

  await writeAgent(bus, { mcpServers: [a, b] })
  // Member-wise merging is what every other field in this section gets, and it
  // is exactly wrong here: it can only ever add, so removing a row would be
  // inexpressible.
  const after2 = await writeAgent(bus, { mcpServers: [a] })
  assert.deepEqual(after2.mcpServers.map((s) => s.name), ['a'])
})

test('a repeated server name is refused rather than allowed to shadow the first', async () => {
  const dir = tempConfigDir()
  const bus = busWith(dir, undefined, workingVault)
  // The name is a tool prefix, and the agent merges by it — a second row under
  // one name would replace the first somewhere downstream, silently. Deciding it
  // here means the form can show which row won.
  const agent = await writeAgent(bus, {
    mcpServers: [
      { name: 'docs', transport: 'http', target: 'https://first/mcp', enabled: true },
      { name: 'docs', transport: 'http', target: 'https://second/mcp', enabled: true },
    ],
  })
  assert.equal(agent.mcpServers.length, 1)
  assert.equal(agent.mcpServers[0]?.target, 'https://first/mcp')
})

test('a name that is not a legal tool prefix is refused by the schema, not stored', async () => {
  const dir = tempConfigDir()
  const bus = busWith(dir, undefined, workingVault)
  // `mcp__My Server__tool` is not addressable. Refusing the write is better than
  // storing a row whose failure mode is "the model ignored your server".
  const res = await bus.dispatch(
    'settings.write',
    { agent: { mcpServers: [{ name: 'My Server', transport: 'http', target: 'https://x/mcp', enabled: true }] } },
    'ui',
  )
  assert.equal(res.ok, false)
  assert.equal(existsSync(join(dir, SETTINGS_FILE_NAME)), false)
})

test('a vault that cannot seal drops the credential rather than storing it in the clear', async () => {
  const dir = tempConfigDir()
  // The default vault refuses, which is what a machine with no keyring does.
  const agent = await writeAgent(busWith(dir), {
    mcpServers: [
      { name: 'docs', transport: 'http', target: 'https://example.com/mcp', authValue: 's3cret', enabled: true },
    ],
  })

  // The server is still configured — it just has no credential, and the form
  // says so. The alternative is a readable secret in a file users paste into
  // issues, which is not a trade peek makes anywhere.
  assert.equal(agent.mcpServers.length, 1)
  assert.equal(agent.mcpServers[0]?.authValueSet, false)
  assert.equal(JSON.stringify(fileJson(dir)).includes('s3cret'), false)
})
