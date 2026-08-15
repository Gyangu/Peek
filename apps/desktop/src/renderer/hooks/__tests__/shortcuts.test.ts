import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildBindings } from '../../keys/bindings'
import { MAX_PANEL_DIGIT, MAX_TAB_DIGIT, resolveShortcut, shortcutHints, type KeyChord } from '../shortcuts'

/* ==================================================================
 * The keyboard map.
 *
 * Three things are guarded here, and the last two are the ones that bite:
 *   - each chord means exactly one thing, including on layouts where Shift
 *     changes the character (US keyboards report '|' for Shift+Backslash);
 *   - **a focused text editor keeps the arrow keys.** CodeMirror's default keymap
 *     binds Mod-Alt-Arrow (multi-cursor) and Mod-Shift-Arrow (extend selection);
 *     a window shortcut that swallowed those would break editing outright, so the
 *     map stands down inside a text entry and Esc is the way back out;
 *   - **the editor does not keep the tab chords**, and that is not an oversight.
 *     `Mod`+digit, `Ctrl-Tab` and `Mod-W` are bound by no CodeMirror keymap, and
 *     switching tab while writing a query is the single thing a user most wants
 *     to do from inside the editor.
 *
 * Two chords changed meaning when panels grew tabs, and both are pinned down
 * from both sides below so a revert cannot pass silently:
 *   - `⌘1 … ⌘9` moved from panels to tabs; panels are `⌘⌥1 … ⌘⌥9`;
 *   - `⌘W` moved from closing a panel to closing a tab; `⌘⇧W` closes the panel.
 * ================================================================== */

/** A chord with everything released; the tests turn on only what they mean. */
const chord = (over: Partial<KeyChord> & Pick<KeyChord, 'key'>): KeyChord => ({
  code: '',
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...over,
})

const WINDOW = { textEntry: false }
const EDITOR = { textEntry: true }

/* ------------------------------------------------------------------ */

describe('resolveShortcut — panel management (existing chords)', () => {
  it('⌘\\ splits left/right and ⌘⇧\\ splits top/bottom', () => {
    assert.deepEqual(resolveShortcut(chord({ key: '\\', code: 'Backslash', meta: true }), WINDOW), {
      kind: 'split',
      dir: 'row',
    })
    assert.deepEqual(
      resolveShortcut(chord({ key: '|', code: 'Backslash', meta: true, shift: true }), WINDOW),
      { kind: 'split', dir: 'col' },
    )
  })

  it('reads the backslash off `code`, so a layout that moves the character still splits', () => {
    // On a US layout Shift+Backslash arrives as '|'; on others the key is
    // somewhere else entirely. `code` is the physical key either way.
    assert.deepEqual(resolveShortcut(chord({ key: '÷', code: 'Backslash', ctrl: true }), WINDOW), {
      kind: 'split',
      dir: 'row',
    })
  })

  it('⌘W closes the visible tab, on either modifier and either case', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'w', meta: true }), WINDOW), { kind: 'closeTab' })
    assert.deepEqual(resolveShortcut(chord({ key: 'W', ctrl: true }), WINDOW), { kind: 'closeTab' })
  })

  it('⌘⇧W is what closes the whole panel now', () => {
    // The other half of the flip. Closing a panel is still reachable in one
    // chord — it just is not the one that discards a single view everywhere
    // else in the user's machine.
    assert.deepEqual(resolveShortcut(chord({ key: 'W', meta: true, shift: true }), WINDOW), {
      kind: 'closePanel',
    })
    assert.deepEqual(resolveShortcut(chord({ key: 'w', ctrl: true, shift: true }), WINDOW), {
      kind: 'closePanel',
    })
  })

  it('leaves ⌘⌥W alone, so a chord built on it stays available', () => {
    assert.equal(resolveShortcut(chord({ key: 'w', meta: true, alt: true }), WINDOW), null)
  })

  it('⌘⌥1 … ⌘⌥9 address panels in visual order, zero-based', () => {
    // Moved off the bare digits when panels grew tabs. ⌥ is already the panel
    // family — ⌘⌥+arrow moves focus between panels — so panel addressing landed
    // where the rest of panel navigation lives.
    assert.deepEqual(resolveShortcut(chord({ key: '1', code: 'Digit1', meta: true, alt: true }), WINDOW), {
      kind: 'focusIndex',
      index: 0,
    })
    assert.deepEqual(resolveShortcut(chord({ key: '9', code: 'Digit9', meta: true, alt: true }), WINDOW), {
      kind: 'focusIndex',
      index: MAX_PANEL_DIGIT - 1,
    })
    assert.equal(resolveShortcut(chord({ key: '0', code: 'Digit0', meta: true, alt: true }), WINDOW), null)
  })

  it('reads the panel digit off `code`, because ⌥1 is not a digit on macOS', () => {
    // With ⌥ held, macOS reports `key: '¡'` for the 1 key. Reading `key` would
    // make the whole panel-digit family unreachable on the platform peek ships
    // on first, and it would fail silently — the chord would simply do nothing.
    assert.deepEqual(resolveShortcut(chord({ key: '¡', code: 'Digit1', meta: true, alt: true }), WINDOW), {
      kind: 'focusIndex',
      index: 0,
    })
    assert.deepEqual(resolveShortcut(chord({ key: '£', code: 'Numpad3', ctrl: true, alt: true }), WINDOW), {
      kind: 'focusIndex',
      index: 2,
    })
  })
})

describe('resolveShortcut — tabs', () => {
  it('⌘1 … ⌘8 select the Nth tab of the focused panel, zero-based', () => {
    assert.deepEqual(resolveShortcut(chord({ key: '1', meta: true }), WINDOW), {
      kind: 'activateTab',
      index: 0,
    })
    assert.deepEqual(resolveShortcut(chord({ key: '8', ctrl: true }), WINDOW), {
      kind: 'activateTab',
      index: 7,
    })
  })

  it('⌘9 selects the *last* tab, not the ninth', () => {
    // What every browser does, and worth more here than a ninth position: a
    // panel holds up to MAX_PANEL_TABS (12) tabs, so the digits cannot reach
    // them all and the end of the strip is the reachable one worth having.
    assert.deepEqual(resolveShortcut(chord({ key: '9', meta: true }), WINDOW), {
      kind: 'activateTab',
      index: 'last',
    })
    assert.equal(MAX_TAB_DIGIT, 9)
  })

  it('⌘0 is nobody’s, and ⌘⇧1 stays free', () => {
    assert.equal(resolveShortcut(chord({ key: '0', code: 'Digit0', meta: true }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: '!', code: 'Digit1', meta: true, shift: true }), WINDOW), null)
  })

  it('⌃Tab cycles forwards and ⌃⇧Tab backwards', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'Tab', ctrl: true }), WINDOW), {
      kind: 'cycleTab',
      delta: 1,
    })
    assert.deepEqual(resolveShortcut(chord({ key: 'Tab', ctrl: true, shift: true }), WINDOW), {
      kind: 'cycleTab',
      delta: -1,
    })
  })

  it('⌃Tab is bound to the real Ctrl on every platform, and ⌘Tab is never ours', () => {
    // macOS cycles tabs with ⌃Tab too (Safari, Chrome, Terminal), so this chord
    // is deliberately not spelled with the `mod` alias. ⌘Tab is the OS
    // application switcher and must never reach the window.
    assert.equal(resolveShortcut(chord({ key: 'Tab', meta: true }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: 'Tab', ctrl: true, alt: true }), WINDOW), null)
    // Plain Tab belongs to the browser's own focus order — and to CodeMirror.
    assert.equal(resolveShortcut(chord({ key: 'Tab' }), WINDOW), null)
  })
})

describe('resolveShortcut — geometric navigation', () => {
  it('⌘⌥ arrows move focus', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'ArrowRight', meta: true, alt: true }), WINDOW), {
      kind: 'focusDirection',
      dir: 'right',
    })
    assert.deepEqual(resolveShortcut(chord({ key: 'ArrowUp', ctrl: true, alt: true }), WINDOW), {
      kind: 'focusDirection',
      dir: 'up',
    })
  })

  it('⌘⇧ arrows move the view into the panel that way', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'ArrowDown', meta: true, shift: true }), WINDOW), {
      kind: 'moveViewDirection',
      dir: 'down',
    })
  })

  it('⌘⌥⇧ arrows move the view past that panel, into a new one', () => {
    assert.deepEqual(
      resolveShortcut(chord({ key: 'ArrowLeft', meta: true, alt: true, shift: true }), WINDOW),
      { kind: 'splitWithViewDirection', dir: 'left' },
    )
  })

  it('an arrow with the modifier alone, or with none at all, is not ours', () => {
    assert.equal(resolveShortcut(chord({ key: 'ArrowRight', meta: true }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: 'ArrowRight' }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: 'ArrowRight', shift: true }), WINDOW), null)
  })
})

describe('resolveShortcut — the editor wins the arrows', () => {
  it('stands down on every arrow chord while a text entry has focus', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      assert.equal(resolveShortcut(chord({ key, meta: true, alt: true }), EDITOR), null, key)
      assert.equal(resolveShortcut(chord({ key, meta: true, shift: true }), EDITOR), null, key)
      assert.equal(resolveShortcut(chord({ key, meta: true, alt: true, shift: true }), EDITOR), null, key)
    }
  })

  it('still closes and splits from inside the editor — CodeMirror binds neither', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'w', meta: true }), EDITOR), { kind: 'closeTab' })
    assert.deepEqual(resolveShortcut(chord({ key: 'W', meta: true, shift: true }), EDITOR), {
      kind: 'closePanel',
    })
    assert.deepEqual(resolveShortcut(chord({ key: '\\', code: 'Backslash', meta: true }), EDITOR), {
      kind: 'split',
      dir: 'row',
    })
  })

  it('keeps the tab chords alive inside the editor, which is the point of them', () => {
    // "I am writing a query and want the other tab" is the single most common
    // thing a user wants to do from inside the editor, and a tab switch that
    // only works after clicking out of the text box is a tab switch nobody uses.
    // CodeMirror's default keymap binds none of Mod+digit, Ctrl-Tab or Mod-W.
    assert.deepEqual(resolveShortcut(chord({ key: '2', meta: true }), EDITOR), {
      kind: 'activateTab',
      index: 1,
    })
    assert.deepEqual(resolveShortcut(chord({ key: '9', meta: true }), EDITOR), {
      kind: 'activateTab',
      index: 'last',
    })
    assert.deepEqual(resolveShortcut(chord({ key: 'Tab', ctrl: true }), EDITOR), {
      kind: 'cycleTab',
      delta: 1,
    })
    assert.deepEqual(resolveShortcut(chord({ key: '1', code: 'Digit1', meta: true, alt: true }), EDITOR), {
      kind: 'focusIndex',
      index: 0,
    })
  })

  it('Esc inside a text entry is the way back out; outside one it is nobody’s', () => {
    assert.deepEqual(resolveShortcut(chord({ key: 'Escape' }), EDITOR), { kind: 'leaveTextEntry' })
    assert.equal(resolveShortcut(chord({ key: 'Escape' }), WINDOW), null)
  })

  it('an Esc somebody has already handled is left alone', () => {
    // CodeMirror's autocomplete calls preventDefault to close its popup. Blurring
    // on that same keystroke would take the editor away mid-typing.
    assert.equal(resolveShortcut(chord({ key: 'Escape', defaultPrevented: true }), EDITOR), null)
  })

  it('ignores any keystroke another handler already claimed', () => {
    assert.equal(
      resolveShortcut(chord({ key: 'ArrowRight', meta: true, alt: true, defaultPrevented: true }), WINDOW),
      null,
    )
  })
})

describe('resolveShortcut — settings', () => {
  it('⌘, and Ctrl+, both open settings', () => {
    for (const mod of [{ meta: true }, { ctrl: true }]) {
      assert.deepEqual(resolveShortcut(chord({ key: ',', code: 'Comma', ...mod }), WINDOW), {
        kind: 'openSettings',
      })
    }
  })

  it('still opens settings from inside the query editor', () => {
    // Unlike the arrow families, this one does not stand down: CodeMirror binds
    // nothing on Mod+Comma, and "open settings" is not an editing operation the
    // editor could plausibly own.
    assert.deepEqual(resolveShortcut(chord({ key: ',', code: 'Comma', meta: true }), EDITOR), {
      kind: 'openSettings',
    })
  })

  it('is read off `code`, so a layout where Shift moves the comma cannot fire it', () => {
    // ⌘⇧, is '<' on a US layout and something else elsewhere. Neither is settings.
    assert.equal(resolveShortcut(chord({ key: '<', code: 'Comma', meta: true, shift: true }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: ',', code: 'Comma', meta: true, alt: true }), WINDOW), null)
  })

  it('a bare comma is just a comma', () => {
    assert.equal(resolveShortcut(chord({ key: ',', code: 'Comma' }), WINDOW), null)
    assert.equal(resolveShortcut(chord({ key: ',', code: 'Comma' }), EDITOR), null)
  })
})

describe('shortcutHints', () => {
  it('spells the modifiers the way the keyboard in front of the user does', () => {
    assert.deepEqual(shortcutHints(true), {
      focus: '⌘⌥ ←↑↓→',
      move: '⌘⇧ ←↑↓→',
      panelDigit: '⌘⌥1…9',
      tabDigit: '⌘1…9',
      lastTab: '⌘9',
      cycleTab: '⌃Tab',
      closeTab: '⌘W',
      closePanel: '⌘⇧W',
    })
    assert.deepEqual(shortcutHints(false), {
      focus: 'Ctrl+Alt ←↑↓→',
      move: 'Ctrl+Shift ←↑↓→',
      panelDigit: 'Ctrl+Alt+1…9',
      tabDigit: 'Ctrl+1…9',
      lastTab: 'Ctrl+9',
      cycleTab: 'Ctrl+Tab',
      closeTab: 'Ctrl+W',
      closePanel: 'Ctrl+Shift+W',
    })
  })

  it('describes the chords the map actually resolves', () => {
    // The status-bar tooltips are the only written record of the keyboard model
    // in the whole window, and two chords changed meaning when panels grew tabs.
    // A hint that outlived its binding is worse than no hint, so the two families
    // that moved are checked against `resolveShortcut` rather than against a
    // second hand-written copy of the same expectation.
    const mac = shortcutHints(true)
    assert.ok(mac.panelDigit.includes('⌥'), 'panel digits are advertised without ⌥')
    assert.ok(!mac.tabDigit.includes('⌥'), 'tab digits are advertised with ⌥')
    assert.deepEqual(resolveShortcut(chord({ key: '9', meta: true }), WINDOW), {
      kind: 'activateTab',
      index: 'last',
    })
    assert.deepEqual(resolveShortcut(chord({ key: 'w', meta: true }), WINDOW), { kind: 'closeTab' })
    assert.deepEqual(resolveShortcut(chord({ key: 'w', meta: true, shift: true }), WINDOW), {
      kind: 'closePanel',
    })
  })
})

describe('resolveShortcut — the user’s own bindings', () => {
  it('answers to a rebound chord and stops answering to the old one', () => {
    const table = buildBindings({ 'panel.splitRow': 'Mod+Alt+Backslash' })
    assert.deepEqual(
      resolveShortcut(chord({ key: '\\', code: 'Backslash', meta: true, alt: true }), WINDOW, table),
      { kind: 'split', dir: 'row' },
    )
    assert.equal(resolveShortcut(chord({ key: '\\', code: 'Backslash', meta: true }), WINDOW, table), null)
  })

  it('a disabled shortcut is nobody’s, and takes nothing else down with it', () => {
    const table = buildBindings({ 'tab.close': null })
    assert.equal(resolveShortcut(chord({ key: 'w', meta: true }), WINDOW, table), null)
    // ⌘⇧W is a separate binding and is untouched.
    assert.deepEqual(resolveShortcut(chord({ key: 'W', meta: true, shift: true }), WINDOW, table), {
      kind: 'closePanel',
    })
  })

  it('carries the whole family when a family is rebound', () => {
    // Rebinding "the tab digits" moves all nine at once, including the ninth's
    // special meaning. Nine bindings that could drift apart would not be a
    // keyboard model anyone could state.
    const table = buildBindings({ 'tab.select': 'Mod+Alt+Shift+<digit>' })
    assert.deepEqual(
      resolveShortcut(chord({ key: '2', code: 'Digit2', meta: true, alt: true, shift: true }), WINDOW, table),
      { kind: 'activateTab', index: 1 },
    )
    assert.deepEqual(
      resolveShortcut(chord({ key: '9', code: 'Digit9', meta: true, alt: true, shift: true }), WINDOW, table),
      { kind: 'activateTab', index: 'last' },
    )
  })

  it('advertises the chord that is bound, not the one that shipped', () => {
    // A hint that outlived its binding is worse than no hint, because it is
    // believed. This is the reason `shortcutHints` reads the table at all.
    const table = buildBindings({ 'panel.close': 'Mod+Alt+KeyQ', 'tab.close': null })
    const hints = shortcutHints(true, table)
    assert.equal(hints.closePanel, '⌘⌥Q')
    assert.equal(hints.closeTab, '')
  })
})
