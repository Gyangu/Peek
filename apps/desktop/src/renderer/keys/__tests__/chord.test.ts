import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ARROW_TOKEN,
  DIGIT_TOKEN,
  chordText,
  formatChord,
  matchChord,
  parseChord,
  recordChord,
  toAccelerator,
  type KeyChord,
} from '../chord'

/* ==================================================================
 * The chord syntax.
 *
 * Two properties carry the whole file, and both are bugs that were paid for
 * before this syntax existed:
 *   - the main key is a `code`, so a layout that moves the character (US Shift+\
 *     is '|') and a modifier that rewrites it (macOS ⌥1 is '¡') both still match;
 *   - `Mod` and `Ctrl` are different modifiers, because ⌃Tab is a real-Ctrl chord
 *     on macOS too and ⌘Tab is the OS application switcher.
 * ================================================================== */

const chord = (over: Partial<KeyChord> & Pick<KeyChord, 'key'>): KeyChord => ({
  code: '',
  meta: false,
  ctrl: false,
  alt: false,
  shift: false,
  ...over,
})

describe('parseChord', () => {
  it('reads modifiers in any order and writes them back in one', () => {
    const a = parseChord('Shift+Mod+KeyW')
    const b = parseChord('Mod+Shift+KeyW')
    assert.ok(a && b)
    assert.equal(chordText(a), chordText(b))
    assert.equal(chordText(a), 'Mod+Shift+KeyW')
  })

  it('accepts the shorthands a human would type, and the ones Electron uses', () => {
    assert.equal(chordText(parseChord('Cmd+w') as never), 'Mod+KeyW')
    assert.equal(chordText(parseChord('CmdOrCtrl+\\') as never), 'Mod+Backslash')
    assert.equal(chordText(parseChord('Mod+,') as never), 'Mod+Comma')
    assert.equal(chordText(parseChord('Mod+Plus') as never), 'Mod+Equal')
    assert.equal(chordText(parseChord('Esc') as never), 'Escape')
  })

  it('rejects what is not a chord, rather than guessing', () => {
    // Every one of these can reach `parseChord` from a hand-edited settings
    // file, and the caller's contract is that one bad entry drops and the rest
    // of the file survives.
    for (const bad of ['', '   ', 'Mod', 'Mod+Nonsense', 'KeyA+KeyB', 'Mod+Mod+KeyA']) {
      assert.equal(parseChord(bad), null, bad)
    }
  })

  it('keeps the two key families as families', () => {
    assert.equal((parseChord('Mod+Alt+<digit>') as never as { token: string }).token, DIGIT_TOKEN)
    assert.equal((parseChord('Mod+Shift+<arrow>') as never as { token: string }).token, ARROW_TOKEN)
  })
})

describe('matchChord', () => {
  it('reads the key off `code`, so Shift moving the character cannot unbind it', () => {
    const pattern = parseChord('Mod+Shift+Backslash')
    assert.ok(pattern)
    // US layout reports '|' with Shift held.
    assert.deepEqual(matchChord(pattern, chord({ key: '|', code: 'Backslash', meta: true, shift: true })), {
      kind: 'plain',
    })
  })

  it('reads a digit off `code`, because ⌥1 is not a digit on macOS', () => {
    const pattern = parseChord('Mod+Alt+<digit>')
    assert.ok(pattern)
    assert.deepEqual(matchChord(pattern, chord({ key: '¡', code: 'Digit1', meta: true, alt: true })), {
      kind: 'digit',
      digit: 1,
    })
  })

  it('falls back to `key` for a synthetic event, which carries no code', () => {
    const pattern = parseChord('Mod+KeyW')
    assert.ok(pattern)
    assert.deepEqual(matchChord(pattern, chord({ key: 'w', meta: true })), { kind: 'plain' })
    assert.deepEqual(matchChord(pattern, chord({ key: 'W', ctrl: true })), { kind: 'plain' })
  })

  it('treats Mod as either modifier, and a literal Ctrl as only Ctrl', () => {
    const mod = parseChord('Mod+KeyW')
    const ctrl = parseChord('Ctrl+Tab')
    assert.ok(mod && ctrl)
    assert.ok(matchChord(mod, chord({ key: 'w', meta: true })))
    assert.ok(matchChord(mod, chord({ key: 'w', ctrl: true })))
    assert.ok(matchChord(ctrl, chord({ key: 'Tab', ctrl: true })))
    // ⌘Tab is the OS application switcher and must never resolve to ours.
    assert.equal(matchChord(ctrl, chord({ key: 'Tab', meta: true })), null)
  })

  it('matches Alt and Shift exactly, which is what keeps ⌘\\ and ⌘⇧\\ apart', () => {
    const plain = parseChord('Mod+Backslash')
    assert.ok(plain)
    assert.equal(matchChord(plain, chord({ key: '|', code: 'Backslash', meta: true, shift: true })), null)
    assert.equal(matchChord(plain, chord({ key: '\\', code: 'Backslash', meta: true, alt: true })), null)
  })

  it('a chord with no modifier does not match one held with a modifier', () => {
    const esc = parseChord('Escape')
    assert.ok(esc)
    assert.deepEqual(matchChord(esc, chord({ key: 'Escape' })), { kind: 'plain' })
    assert.equal(matchChord(esc, chord({ key: 'Escape', meta: true })), null)
  })
})

describe('formatChord', () => {
  it('spells the modifiers the way the keyboard in front of the reader does', () => {
    const w = parseChord('Mod+Shift+KeyW')
    assert.ok(w)
    assert.equal(formatChord(w, true), '⌘⇧W')
    assert.equal(formatChord(w, false), 'Ctrl+Shift+W')
  })

  it('gives an arrow family room to breathe, on both platforms', () => {
    // `⌘⌥←↑↓→` runs together into something unreadable; the space is what makes
    // it read as "this modifier, then any of these".
    const arrows = parseChord('Mod+Alt+<arrow>')
    assert.ok(arrows)
    assert.equal(formatChord(arrows, true), '⌘⌥ ←↑↓→')
    assert.equal(formatChord(arrows, false), 'Ctrl+Alt ←↑↓→')
  })
})

describe('toAccelerator', () => {
  it('produces what `main/menu.ts` writes by hand today', () => {
    assert.equal(toAccelerator(parseChord('Mod+Digit0') as never), 'CmdOrCtrl+0')
    assert.equal(toAccelerator(parseChord('Mod+Comma') as never), 'CmdOrCtrl+,')
  })

  it('has none for a key family, which is why the menu carries no family', () => {
    assert.equal(toAccelerator(parseChord('Mod+<digit>') as never), null)
  })
})

describe('recordChord', () => {
  it('is silent while only modifiers are down', () => {
    // Holding ⌘ on the way to ⌘⇧W is not a chord. A recorder that committed on
    // the first keydown would record ⌘ every single time.
    assert.equal(recordChord(chord({ key: 'Meta', meta: true })), null)
    assert.equal(recordChord(chord({ key: 'Shift', shift: true })), null)
  })

  it('records a digit or an arrow as its family, because that is the unit bound', () => {
    assert.equal(chordText(recordChord(chord({ key: '3', code: 'Digit3', meta: true, alt: true })) as never), 'Mod+Alt+<digit>')
    assert.equal(chordText(recordChord(chord({ key: 'ArrowLeft', meta: true, shift: true })) as never), 'Mod+Shift+<arrow>')
  })

  it('records Ctrl as Mod, so a binding made on a PC works on a Mac', () => {
    assert.equal(chordText(recordChord(chord({ key: 'k', code: 'KeyK', ctrl: true })) as never), 'Mod+KeyK')
    assert.equal(chordText(recordChord(chord({ key: 'k', code: 'KeyK', meta: true })) as never), 'Mod+KeyK')
  })
})
