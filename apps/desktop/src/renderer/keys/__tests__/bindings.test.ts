import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { en } from '../../i18n/messages/en'
import { zhCN } from '../../i18n/messages/zh-CN'
import { buildBindings, conflictsWith, findConflicts, toOverrides } from '../bindings'
import { chordText, parseChord } from '../chord'
import { DEFAULT_PATTERNS, SHORTCUTS } from '../registry'

/* ==================================================================
 * The registry, and the user's changes to it.
 *
 * The load-bearing assertion in this file is the first one: peek's own keyboard
 * has no chord that means two things. It is cheap to state and it is the check
 * nobody would remember to run by hand when adding the twenty-ninth shortcut.
 * ================================================================== */

describe('the registry itself', () => {
  it('binds no chord to two shortcuts', () => {
    // Menu accelerators are checked against the window's chords, not only
    // against each other: the OS resolves an accelerator *before* the keystroke
    // reaches the web contents, so a colliding menu item wins silently and for
    // good. That is the failure `main/menu.ts` describes in prose at the top.
    assert.deepEqual(findConflicts(), [])
  })

  it('describes every shortcut in both languages', () => {
    for (const def of SHORTCUTS) {
      assert.ok(def.labelKey in en, `${def.id} has no English label`)
      assert.ok(def.labelKey in zhCN, `${def.id} has no Chinese label`)
    }
  })

  it('has a parseable default for every entry', () => {
    for (const def of SHORTCUTS) {
      assert.ok(DEFAULT_PATTERNS.get(def.id), def.id)
      assert.equal(
        chordText(DEFAULT_PATTERNS.get(def.id) as never),
        chordText(parseChord(def.default) as never),
      )
    }
  })

  it('offers rebinding only for chords peek invented', () => {
    // The rule the settings form obeys rather than decides: a user learned
    // Enter-sends and ⌘C-copies from their operating system, and rebinding those
    // only builds an app that disagrees with every other app on the machine.
    for (const def of SHORTCUTS) {
      if (def.scope !== 'window') assert.equal(def.rebindable, false, `${def.id} is rebindable`)
    }
  })
})

describe('buildBindings', () => {
  it('applies an override', () => {
    const table = buildBindings({ 'panel.splitRow': 'Mod+Alt+Backslash' })
    assert.equal(chordText(table.get('panel.splitRow') as never), 'Mod+Alt+Backslash')
  })

  it('treats null as "off", which is not the same as absent', () => {
    const table = buildBindings({ 'tab.close': null })
    assert.equal(table.get('tab.close'), null)
    assert.ok(buildBindings({}).get('tab.close'))
  })

  it('drops a bad entry and keeps the good ones', () => {
    // The settings file is hand-editable. One typo must read as "that one is not
    // set", never as a factory reset of the whole keyboard.
    const table = buildBindings({ 'panel.splitRow': 'not a chord', 'panel.close': 'Mod+Alt+KeyQ' })
    assert.equal(chordText(table.get('panel.splitRow') as never), 'Mod+Backslash')
    assert.equal(chordText(table.get('panel.close') as never), 'Mod+Alt+KeyQ')
  })

  it('ignores an id this build does not know', () => {
    const table = buildBindings({ 'panel.teleport': 'Mod+KeyT' })
    assert.equal(table.size, SHORTCUTS.length)
  })

  it('refuses to rebind what the registry says is not rebindable', () => {
    // The form will not offer it, but the form is not the enforcement — the file
    // is hand-editable and reaches this function directly.
    const table = buildBindings({ 'grid.copy': 'Mod+KeyJ', 'tab.cycleNext': null })
    assert.equal(chordText(table.get('grid.copy') as never), 'Mod+KeyC')
    assert.ok(table.get('tab.cycleNext'))
  })
})

describe('toOverrides', () => {
  it('writes back only what differs from the default', () => {
    // A binding set back to its default disappears from the file rather than
    // being written out as a literal copy, so retuning a default later still
    // reaches everyone who never disagreed with it.
    assert.deepEqual(toOverrides(buildBindings()), {})
    assert.deepEqual(toOverrides(buildBindings({ 'panel.close': 'Mod+Alt+KeyQ' })), {
      'panel.close': 'Mod+Alt+KeyQ',
    })
  })

  it('keeps a disabled shortcut, because "off" is a choice', () => {
    assert.deepEqual(toOverrides(buildBindings({ 'tab.close': null })), { 'tab.close': null })
  })
})

describe('conflicts', () => {
  it('finds a chord the user pointed at something already bound', () => {
    const table = buildBindings({ 'panel.splitRow': 'Mod+KeyW' })
    const conflicts = findConflicts(table)
    assert.equal(conflicts.length, 1)
    assert.deepEqual(new Set(conflicts[0]?.ids), new Set(['panel.splitRow', 'tab.close']))
  })

  it('counts a family and one of its members as a collision', () => {
    // ⌘3 cannot both select a tab and split a panel, so this has to be a
    // conflict even though the two patterns are not equal.
    const hits = conflictsWith('panel.splitRow', parseChord('Mod+Digit3') as never, buildBindings())
    assert.deepEqual(hits, ['tab.select'])
  })

  it('leaves the same key in two scopes alone', () => {
    // Escape closes a dialog, clears a grid selection and leaves the editor.
    // Three meanings, one key, no conflict: they are the same key doing the
    // analogous thing to whatever has focus.
    assert.deepEqual(findConflicts(buildBindings()), [])
    assert.deepEqual(conflictsWith('grid.clearSelection', parseChord('Escape') as never, buildBindings()), [])
  })

  it('sees a window chord shadowed by a menu accelerator', () => {
    const table = buildBindings({ 'panel.splitRow': 'Mod+Digit0' })
    const hits = conflictsWith('panel.splitRow', parseChord('Mod+Digit0') as never, table)
    assert.deepEqual(hits, ['menu.zoomActual'])
  })
})

/* ==================================================================
 * The application menu.
 *
 * `main/menu.ts` cannot be imported here — it imports Electron, which does not
 * load in a plain Node test — so the guard reads its source. That is unusual and
 * it is worth the oddity: a menu accelerator is resolved by the OS *before* the
 * keystroke reaches the web contents, so an accelerator nobody registered can
 * take a window chord away silently and permanently, and no amount of prose at
 * the top of `menu.ts` has ever stopped that from being possible.
 * ================================================================== */

describe('menu accelerators', () => {
  const source = readFileSync(new URL('../../../main/menu.ts', import.meta.url), 'utf8')

  it('are all registered, so `findConflicts` can see them', () => {
    const written = [...source.matchAll(/accelerator: '([^']+)'/g)].map((hit) => hit[1] as string)
    assert.ok(written.length > 0, 'no accelerators found — has menu.ts moved?')

    for (const accelerator of written) {
      const pattern = parseChord(accelerator)
      assert.ok(pattern, `${accelerator} is not a chord this syntax can express`)
      const registered = SHORTCUTS.some((def) => {
        const bound = DEFAULT_PATTERNS.get(def.id)
        return bound !== undefined && chordText(bound) === chordText(pattern)
      })
      // `Command+,` is registered as the window's `app.settings` rather than as
      // its own menu entry, because it *is* that action — the menu is a second
      // door to it, not a second shortcut.
      assert.ok(registered, `${accelerator} is in the menu but in no registry entry`)
    }
  })
})
