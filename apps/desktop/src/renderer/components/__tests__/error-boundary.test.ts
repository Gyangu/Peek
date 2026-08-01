import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CATALOGS } from '../../i18n/catalog'
import { LOCALES } from '../../i18n/locales'

/* ==================================================================
 * The window-level error boundary.
 *
 * Why this is worth a test at all: the renderer is a mirror of state owned by
 * main, so a value it cannot draw can appear anywhere in the tree, and React's
 * response to an uncaught render error is to unmount the whole thing. What the
 * user then sees is a blank window — patches keep arriving and are applied
 * correctly, main reports every command as a success, and nothing anywhere says
 * the UI is dead. The only way out is the Reload menu item, if the user knows it
 * exists.
 *
 * The boundary itself is a .tsx file, and node's type stripper does not compile
 * JSX, so it cannot be rendered here. What is pinned down instead is the shape:
 * that it is installed, that it implements both halves of React's error contract,
 * that it offers a way out, and that it leaves a trace in the log. Every one of
 * those is a line a refactor can delete without anything else noticing.
 * ================================================================== */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const BOUNDARY = src('../ErrorBoundary.tsx')
const MAIN_TSX = src('../../main.tsx')

describe('the boundary is installed around the whole window', () => {
  it('main.tsx wraps App, not some subtree of it', () => {
    assert.match(MAIN_TSX, /import\s*\{\s*ErrorBoundary\s*\}/, 'main.tsx does not import the boundary')
    // The App tag has to sit inside the boundary tags, in that order.
    const open = MAIN_TSX.indexOf('<ErrorBoundary>')
    const app = MAIN_TSX.indexOf('<App />')
    const close = MAIN_TSX.indexOf('</ErrorBoundary>')
    assert.ok(open !== -1 && close !== -1, 'App is not wrapped in an ErrorBoundary')
    assert.ok(open < app && app < close, 'App is rendered outside the boundary')
  })
})

describe('the boundary honours both halves of React’s error contract', () => {
  it('renders a fallback and reports the failure', () => {
    // getDerivedStateFromError is what swaps in the fallback; componentDidCatch
    // is the only place with the component stack. Implementing one without the
    // other means either no fallback or no diagnosis.
    assert.match(BOUNDARY, /static getDerivedStateFromError/)
    assert.match(BOUNDARY, /componentDidCatch/)
  })

  it('logs the error, which is how it reaches the main-process log', () => {
    // main forwards renderer console errors in every build (main/index.ts), and
    // that log line is the only trace a blank window leaves behind.
    assert.match(BOUNDARY, /console\.error\(/)
  })

  it('offers exactly one way out, and it is one that always works', () => {
    // A reload rebuilds the renderer and pulls a fresh snapshot. Nothing of value
    // lives in this process, so there is nothing to lose by taking it.
    assert.match(BOUNDARY, /location\.reload\(\)/)
  })

  it('never tries to repair the mirror it failed to render', () => {
    // Guessing at half-broken state is how a display bug becomes a wrong answer
    // about somebody's database. Reload, or nothing.
    assert.ok(!BOUNDARY.includes('useWorkspaceStore'), 'the boundary reaches into the mirror')
    assert.ok(!/\bapplyPatches\b/.test(BOUNDARY), 'the boundary edits state')
    assert.ok(!BOUNDARY.includes('dispatch('), 'the boundary sends commands from a broken window')
  })
})

describe('its text is translated like everything else the user reads', () => {
  const KEYS = ['app.crash.title', 'app.crash.body', 'app.crash.reload'] as const

  it('uses catalog keys rather than inline English', () => {
    for (const key of KEYS) {
      assert.ok(BOUNDARY.includes(`'${key}'`), `${key} is not used by the boundary`)
    }
  })

  it('every locale supplies them', () => {
    for (const { id } of LOCALES) {
      for (const key of KEYS) {
        const message = CATALOGS[id][key]
        assert.equal(typeof message, 'string', `${id} is missing ${key}`)
        assert.notEqual(message, '', `${id} / ${key} is empty`)
      }
    }
  })
})
