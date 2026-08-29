# The keyboard system: a registry, a shortcut sheet, and user rebinding

## 1. What this fixes

### 1.1 Where things stand

Window-level chords already have a clean set of layers, and this does not overturn them:

- `renderer/hooks/shortcuts.ts` — the pure-function key table. `resolveShortcut(chord,
  ctx)` translates a `KeyboardEvent`'s significant bits into a `ShortcutAction`, testable
  without a DOM.
- `renderer/hooks/useGlobalKeys.ts` — does nothing but intent → Command translation;
  writes no store.
- `renderer/hooks/modalStack.ts` — Esc's ownership stack; the dialog at the top of the
  stack eats the key.
- `main/menu.ts` — the application menu's accelerators (`⌘0` / `⌘+` / `⌘-` / `⌘,`).

What is missing is the "system" layer:

1. **There is no single source of truth.** The main process's accelerators and the
   renderer's key table are each written on their own. A conflict between them (the menu
   resolves before web contents) is flagged only by a prose comment at the top of
   `menu.ts`, and nothing at all will stop the next person adding an accelerator.
2. **Component-local keys float outside it.** DataGrid's `⌘A` / `⌘C` / `⌘↑↓`,
   Composer's `Enter` / `⇧Enter` / `⌫`, Menu's and Segmented's arrow-key navigation are
   all `onKeyDown` handlers written in place, registered nowhere. Answering "what
   shortcuts does this app have in total" today means grep.
3. **They are not discoverable.** In the whole window only two status-bar tooltips write
   a key down, with the labels hard-coded in `shortcutHints()`. Adding a chord means
   editing two places, and the user has nowhere to see them all.
4. **They cannot be rebound.** The key table is a compile-time constant.

### 1.2 Boundary

**Done:**

- One shortcut registry covering the whole app, from which the window layer's dispatch
  reads.
- A shortcut sheet (`⌘/`) listing every key by scope.
- A Keyboard section in settings: window-layer chords can be rebound, disabled and
  restored to default, persisted to `~/.peek/settings.json`.
- Conflict detection at startup (including cross-detection against the main process's
  menu accelerators).

**Not done:**

- **Component-local keys' dispatch path is not rewritten.** DataGrid / Composer / Menu /
  Segmented keep their own `onKeyDown`. They are in the registry **as declarations
  only, not for dispatch** — registering makes them appear in the shortcut sheet and take
  part in conflict detection, but the keys are still handled by the component. The reason
  is in §3.1.
- **Component-local keys are not opened up for rebinding.** `Enter` to send, `⌘C` to
  copy, arrow keys to move the highlight in a menu are system-level conventions, and
  letting the user change them only manufactures a state inconsistent with the platform.
  They are read-only rows in settings.
- No chord sequences (two-part things like `⌘K ⌘S`). There is not one of them today, and
  designing a parser for a need that does not exist does not pay.
- No change to the meaning of any existing key. `⌘1…⌘9` is still tabs, `⌘⌥1…⌘⌥9` is
  still panels, the editor still wins the arrow keys. This only changes **where those
  rules come from**.

## 2. The plan

### 2.1 The textual form of a chord

Keys pass between the registry, settings.json and the UI as strings, of the form:

```
Mod+Backslash        Mod+Shift+W       Ctrl+Tab        Escape
Mod+<digit>          Mod+Alt+<arrow>   Mod+Alt+Shift+<arrow>
```

The rules:

- Modifiers are in the fixed order `Mod`, `Ctrl`, `Alt`, `Shift`, and are compared only
  after normalisation, so `Shift+Mod+W` and `Mod+Shift+W` are the same chord.
- `Mod` = `⌘` on macOS and `Ctrl` elsewhere; `Ctrl` is the **real** Ctrl (`⌃Tab` binds
  the real Ctrl on both platforms, because `⌘Tab` is the system's application switcher).
- The main key is written as `KeyboardEvent.code` (`Backslash`, `Comma`, `KeyW`,
  `Digit1`), not `key`. This is a hole the existing code has already fallen into: with
  Shift held, `\` on a US layout reports as `|`, and with ⌥ held, `1` reports as `¡`.
- Two placeholders keep parameterised key families: `<digit>` expands to `Digit1…Digit9`
  and `Numpad1…Numpad9`, `<arrow>` expands to the four arrow keys. Rebinding a key family
  changes the modifier prefix, not each key one at a time — which is exactly what these
  families look like in a person's head.

`keys/chord.ts` provides `parseChord`, `formatChord(chord, mac)` (giving the UI `⌘⌥←` or
`Ctrl+Alt+←`), `matchChord(pattern, event)`, and `toAccelerator(pattern)` (for the
Electron menu, used in conflict detection).

### 2.2 The registry

`keys/registry.ts` is the single source of truth:

```ts
interface ShortcutDef {
  id: ShortcutId                 // 'panel.splitRow' | 'grid.copy' | …
  scope: ShortcutScope           // 'window' | 'menu' | 'grid' | 'composer' | 'nav' | 'modal'
  default: string                // the chord pattern
  /** Component-local keys and menu accelerators cannot be changed. */
  rebindable: boolean
  /** Stands down while the focus is in a text entry. */
  standDownInTextEntry: boolean
  labelKey: KeyboardMessageKey   // the wording in the shortcut sheet and in settings
}
```

Only entries whose `scope` is `'window'` take part in `resolveShortcut`'s dispatch; the
rest are **declarations**, there to make the shortcut sheet complete and to make conflict
detection see them. Whether an entry dispatches is decided by `scope` alone, with no
separate `dispatched` field — the third combination two fields could express (not
`window` yet dispatching) has no corresponding implementation, and keeping it would only
suggest it is an option.

### 2.3 Dispatch

`resolveShortcut` keeps today's signature semantics and takes one more argument, a
binding table:

```ts
resolveShortcut(chord: KeyChord, ctx: ShortcutContext, bindings?: BindingTable): ShortcutAction | null
```

With `bindings` omitted it uses the default table, so existing tests and call sites are
unchanged. The body goes from "a run of ifs" to "a lookup in the binding table", but
**every existing stand-down rule is kept**: the `defaultPrevented` short-circuit, giving
up the arrow keys inside a text entry, Esc only meaning anything inside a text entry.
Those rules are now expressed by `standDownInTextEntry` on the entry, rather than being
scattered `if (ctx.textEntry) return null`s.

`useGlobalKeys` does exactly one more thing: subscribe to the binding table and
reinstall the listener after a rebind. The intent → Command part does not change a line.

### 2.4 Persisting the user's rebinds

New in `settings.json`:

```jsonc
"keybindings": {
  "panel.splitRow": "Mod+Alt+Backslash",  // rebound
  "tab.close": null                        // disabled
}
```

- A key name not in the registry → discarded (an entry left over from an older version
  should not come back to life).
- A value that is not a legal chord → discard that entry, keep the rest (following
  `project()`'s existing "drop the bad key, keep the good ones" principle).
- A value pointing at an id that cannot be rebound → discarded.
- `null` means "turn this one off", which is different from "never written", so it stays
  in the file as null.

Reading and writing go through the existing `settings.read` / `settings.write` commands.
Unlike `executionTimeouts`, `keybindings` is **replaced whole rather than merged by
member**: restoring one shortcut to its default requires it to *disappear* from the file,
and a member-wise merge can never express that. The renderer sends the complete record
every time, so the file cannot lose an override the sender still holds.

### 2.5 Conflict detection

`keys/bindings.ts` exports `findConflicts(table)`: within one scope, two patterns that
intersect are a conflict (intersecting key families are computed over the expanded sets).
Across scopes is not a conflict — `⌘C` in the grid and `⌘C` in a text box are two
different things to begin with.

Menu accelerators are the exception and have to be checked across layers: the menu
resolves before web contents, and an accelerator identical to a window-layer chord takes
it away silently. Entries with `scope: 'menu'` in the registry exist for this, and the
detection treats them as being in the same scope as `'window'`.

The detection runs in two places:

- **Tests**: `findConflicts()` asserts empty against the default table, and adding a
  colliding entry fails the test outright.
- **The settings panel**: `conflictsWith` warns live while a new key is being captured.
  A conflict **does not refuse the save**; it only marks which entry is being shadowed —
  refusing would force the user to reason about the order of two swaps, and this is a
  visible, undoable, one-click-restorable mistake.

The guard on menu accelerators is an unusual construction: `main/menu.ts` imports
electron and cannot be loaded in a node test, so the guard **reads its source text**,
parses every `accelerator: '…'` into a chord, and asserts a matching entry exists in the
registry. Unorthodox, but what it buys is that the warning about "an accelerator will
silently take a window chord away" becomes, for the first time, an executable check.

### 2.6 UI

- **The shortcut sheet**: a modal toggled by `⌘/` (the same key closes it), listing the
  registry grouped by scope, with `formatChord` in the right column. It takes over the
  "the only record of the keys" job the status-bar tooltips were carrying — the tooltips
  stay, but are no longer the sole source.
- **Settings › Keyboard**: the new `KeyboardSection`. One registry entry per row:
  description, current chord, a capture button, restore to default. A row that cannot be
  rebound is plain read-only text (not a disabled button — there is no disable-able
  action here). During capture, `⌫` means "turn this one off" and `Esc` abandons the
  capture; a conflict is flagged in place, and the save is allowed but says which entry
  is being shadowed.
- **i18n**: `messages/{en,zh-CN}/keyboard.ts` gains a label per entry plus the sheet's
  copy. Modifier symbols are still not translated (following `shortcutHints`'s existing
  reason: that is what is printed on the keycap).
- `shortcutHints()` stays, but is derived from the registry rather than copied by hand.

## 3. Trade-offs

### 3.1 Why not a unified dispatcher

Pulling DataGrid's / Composer's / Menu's entire keyboard path into one central keymap
dispatching over a scope stack was considered. It was dropped because the benefit and the
risk are asymmetric:

- These components' key handling is **entangled with their local state**. Composer's
  `Enter` has to look at the IME composition state and at whether the mention menu is
  open; `⌫` has to look at whether the cursor is collapsed and whether it is sitting on
  an atomic mention. Moving that into a central dispatcher means exposing component
  internal state as dispatch context, in exchange for nothing but the formal tidiness of
  "one entry point".
- CodeMirror comes with its own keymap and its own precedence system (`Prec.high`,
  `defaultKeymap`). A central dispatcher either goes around it or fights it, and both
  roads turn "the editor wins the arrow keys" — a rule that is already stable — back into
  a live bug.

The registry gets 90% of the unified dispatcher's actual benefit — a complete overview,
conflict detection, documentability — without touching a single key path that already
works.

### 3.2 Why component keys cannot be rebound

`Enter` to send, `⌘C` to copy, `↑↓` to move within a list are things the user learned
from the operating system, not from peek. Opening them up for rebinding means allowing
the user to configure the app into a state inconsistent with the platform, and the
support cost of that kind of state far exceeds the need it satisfies. Window-layer chords
are different: `⌘\` to split and `⌘⌥1` to focus the Nth panel are peek's own inventions,
and a user has a legitimate reason to find them awkward.

### 3.3 Why `code` rather than `key`

Already explained in §2.1; it is an existing conclusion of the existing code (the
Backslash and digit comments in `shortcuts.ts`), and this only promotes it to a rule of
the chord syntax. The cost is that the settings panel shows the physical key position,
which on a non-US layout may not match the keycap; `formatChord` mitigates it by mapping
common codes to symbols.

### 3.4 Why no chord sequences

There is not one two-part shortcut today, and peek's command surface is not large enough
to need a `⌘K` prefix. Adding a parser means paying the cost of a timeout state machine
for a need that does not exist. The registry's chord field is a string, so adding them
later will not be blocked by today's structure.

## 4. Verification

**Tests (`node --test`)**

- `keys/__tests__/chord.test.ts`: parsing, normalisation (modifiers out of order are
  equivalent), formatting for both platforms, key-family expansion, accelerator
  conversion.
- `keys/__tests__/bindings.test.ts`: zero conflicts in the default table (menu
  cross-layer included), every entry has an English and a Chinese label, no non-window
  scope is rebindable; merging user overrides, discarding bad values, `null` disabling,
  a non-rebindable id being refused, conflicts being detected; plus reading
  `main/menu.ts`'s source and asserting its accelerators are all registered.
- `hooks/__tests__/shortcuts.test.ts`: every existing assertion still passes (this is the
  main safety net for this change — key semantics may not change), plus "`⌘⌥\` triggers
  the split under a custom binding table".
- `main/bus/__tests__/settings.test.ts`: `keybindings`'s read projection, whole
  replacement, bad-value discarding, and the whole field being absent when nothing has
  been changed.

**Manual**

1. Every existing chord (split, close tab, ⌘1…⌘9, ⌃Tab, ⌘⌥ arrows, ⌘⇧ arrows, ⌘,)
   behaves unchanged.
2. `⌘/` opens the shortcut sheet, Esc closes it, and the stack ownership is right (with
   the sheet open, Esc does not clear the grid selection).
3. Settings › Keyboard: change `⌘\` to `⌘⌥\`, close the dialog; the new key works and
   the old one does not; still in effect after a restart.
4. Change one into a conflict with `⌘W`; the panel marks it red in place and says which
   entry is being shadowed.
5. Hand-edit `settings.json` to `"panel.splitRow": "不是键"`; after starting, that entry
   is back to its default and the other customisations are kept.
6. After restoring a default, that key disappears from `settings.json` rather than being
   written as the default's literal value.

## 5. Where it lands

| concern | file |
| --- | --- |
| chord syntax: parsing, matching, formatting, capture, accelerators | `renderer/keys/chord.ts` |
| the registry and the default keys | `renderer/keys/registry.ts` |
| merging user overrides, conflict detection | `renderer/keys/bindings.ts` |
| the binding table in effect (store) | `renderer/keys/store.ts` |
| id → intent | `renderer/hooks/shortcuts.ts` |
| intent → Command | `renderer/hooks/useGlobalKeys.ts` |
| the shortcut sheet | `renderer/components/ShortcutSheet.tsx` |
| Settings › Keyboard | `renderer/components/settings/KeyboardSection.tsx` |
| persistence | `main/config/settings.ts`, `main/config/handlers.ts`, `core/commands.ts` |
