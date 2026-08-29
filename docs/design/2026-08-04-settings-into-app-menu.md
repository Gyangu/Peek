# Settings moves into the App menu, and the title bar falls back to a strip of pure chrome

> 2026-08-04. Trigger: the user said "on Mac, tuck settings away into the menu
> bar — that should save a bit more of the top area, no?"

## 1. What this fixes

### 1.1 Where things stand

The title bar (`App.tsx`'s `.titlebar`) is a 34px strip carrying four things:

| content | note |
|---|---|
| the word `peek` | decoration. Writing your own name in the window title bar is a web page's habit, not a mac application's |
| `app.syncing` | one line of text shown before the first snapshot comes back, when `ready === false` |
| `app.bridgeNotReady` | the preload bridge is missing. **The status bar already carries a copy** (`status.preloadMissing`, `StatusBar.tsx:96`) |
| the ⚙ gear | the settings dialog's only visible entry point |

On macOS the window is `titleBarStyle: 'hiddenInset'`, so those 34px carry the
traffic lights' landing spot and the window drag region at the same time.

Meanwhile, `main/menu.ts` holds an explicit decision in the opposite direction:

> Not here on purpose: a **Settings…** item. `⌘,` is handled in the renderer
> (`useGlobalKeys`), and a menu item carrying that accelerator would take the
> chord away from it and then need an IPC channel to give the same behaviour
> back. […] adding a third door is not worth a new channel.

### 1.2 The problem

The gear growing out of the title bar is `2026-08-02-settings-panel.md` §2.1's
conclusion — what it was compared against back then was "the sidebar's
`Connections` header row", and the title bar really is the better of those two.
But it has never been taken and weighed against the **App menu**: on macOS,
`application name → Settings…` is the **canonical location** for settings,
canonical enough that a user looks in the menu first and only sweeps the
interface after failing to find it there. The gear in the window is therefore a
non-standard entry point occupying a piece of window area.

And of the four things in §1.1's table, three are either decoration or already
have a more appropriate home elsewhere. Cleared out, the title bar is left with
only its real job: the traffic lights' slot plus the drag region.

### 1.3 Checked against the existing documents

**Conflict 1 — the "no Settings… item here on purpose" note at the top of
`main/menu.ts`. Overturned.**

The original argument had two legs:

1. *the accelerator takes `⌘,` away from the renderer and needs a new IPC
   channel to hand the behaviour back* — **still holds**, and this change is
   paying that price (§2.2).
2. *the dialog already opens from the gear and from `⌘,`, so a third door is not
   worth a new channel* — **the premise is gone**. The gear is being removed on
   mac this time, so the menu item is not a third door; it is the door that
   **replaces** the gear.

**Conflict 2 — `2026-08-02-settings-panel.md` §2.1 writes the entry points as
"title bar gear + `⌘,` + FirstRunGuide". Rewritten.**

That document's claim is "settings belong to the window, not to a connection or
a panel" — that is not overturned; the App menu is equally a window-level
surface, and on mac it is more of one. What changes is the list of entry points,
not the reasoning behind it. Checked with the user and confirmed (2026-08-04).

**Conflict 3 — a three-way deadlock with `2026-08-04-sidebar-collapse.md` §2.1.
See §3.1.**
This is the part of this document most worth keeping: it explains why the title
bar is **thinned** rather than **deleted**.

### 1.4 Boundary (explicitly not done)

- **The title bar is not deleted.** The reason is in §3.1; it is this change's
  one "wanted to, could not".
- **No shortcut other than `⌘,` is touched**, and no other action item is added
  to the menu. This moves one entry point, nothing more.
- **No i18n for the Electron menu.** The menu is built in main and the i18n
  catalogue lives in the renderer; the existing menus (Edit / View / Window) are
  all English, and one item is not worth opening the main-side localisation pit.
- **Non-mac is untouched**: Windows / Linux have no persistent menu bar
  (`menu.ts` currently gives non-mac only `File → Quit`), so the gear stays in
  the title bar.
- **The settings dialog itself is untouched**: sections, forms and
  `settings.read/write` do not change by a line.

## 2. The plan

### 2.1 One item added to mac's App menu

```
peek
  About peek
  ───────────
  Settings…            ⌘,      ← new
  ───────────
  Services / Hide / … / Quit
```

The position is mac's conventional slot: after About, before Services, in a
group of its own.

### 2.2 `⌘,` belongs to the menu, and the behaviour returns to the renderer over a new channel

A menu accelerator is resolved by the system **before** the event reaches the
web contents, so once `⌘,` hangs on a menu item the renderer's keydown never
sees it again. This is not something both sides can keep; one side has to be
chosen — the menu, because a mac menu item showing no shortcut reads as
crippled.

So a main → renderer push is needed:

```ts
// packages/core/src/ipc.ts
MENU_ACTION: 'peek:menu:action'          // M→R
export interface MenuActionMessage { action: 'openSettings' }
```

`PeekBridge` gains `onMenuAction(handler): () => void`, in the same group as
`onNotify` (a required member, not the "optional extension" group) — both
preload paths (the main-world bootstrap and the degraded fallback) implement it,
because it is only an `ipcRenderer.on`, has nothing to do with the data plane,
and has no reason to degrade along with it.

On the renderer side, a new `hooks/useMenuActions.ts`: subscribe to the channel
and translate messages into actions. The translation itself is a pure function
`applyMenuAction(msg)`, so it can be tested outside React — exactly the division
of labour `shortcuts.ts` has with `resolveShortcut`.

**Why not the existing `NOTIFY` channel.** `NotifyMessage` is
`{ level, message, detail? }`, meaning "show the user a line of text", and what
receives it on the renderer side is a toast. Stuffing "actually, please open
settings" in there means teaching the toast system about something that is not a
toast.

**`⌘,` still belongs to the renderer off mac.** No menu item is added off mac,
so `shortcuts.ts`'s `openSettings` branch stays exactly as it is. On mac that
branch becomes unreachable code (keydown cannot get there); the reason for
keeping it is that both platforms share one shortcut table, and trimming it for
one platform means writing one more condition, not fewer. A comment in
`useGlobalKeys` records this.

### 2.3 The title bar is cleared out and thinned to 30px

| original content | where it goes |
|---|---|
| the word `peek` | deleted |
| `app.syncing` | moved into the status bar (one cell, when `ready === false`) |
| `app.bridgeNotReady` | deleted — the status bar already has `status.preloadMissing`, so this was two copies |
| the ⚙ gear | mac: deleted (it goes into the menu); non-mac: kept |

Height 34px → `var(--bar-h)` (30px), aligned with the sidebar header, the panel
header and the status bar — there is no longer a fifth height in the window.

On mac the window switches to `titleBarStyle: 'hidden'` +
`trafficLightPosition: { x: 12, y: 9 }`: with `hiddenInset` the traffic lights'
vertical landing point is decided by the system (centred at roughly 19px), which
sits too low once the strip is squeezed to 30px; given an explicit position, the
12px buttons land on y ∈ [9, 21], exactly centred in 30px. The left padding
follows, from 82px down to 72px (the traffic lights' right edge at roughly 64px
+ 8px of slack), and **applies only on mac** — today those 82px are
unconditional, and on Windows they are an empty gap left for nothing. The
platform difference goes through the `.app.mac` class name (`isMacPlatform()`,
already present in the renderer).

### 2.4 Files involved

| file | change |
|---|---|
| `packages/core/src/ipc.ts` | add `IPC.MENU_ACTION`, `MenuActionMessage`, `PeekBridge.onMenuAction` |
| `apps/desktop/src/preload/index.ts` | both paths implement `onMenuAction` |
| `apps/desktop/src/main/menu.ts` | mac's App menu gains `Settings… ⌘,`; rewrite that "not here on purpose" comment at the top |
| `apps/desktop/src/main/index.ts` | `installAppMenu` takes `onOpenSettings`; the window switches to `hidden` + `trafficLightPosition` |
| `renderer/hooks/useMenuActions.ts` | new: `applyMenuAction` + `useMenuActions` |
| `renderer/hooks/index.ts` | export both of the above |
| `renderer/components/App.tsx` | title bar cleared out; no gear rendered on mac; `mac` class on the root node; call `useMenuActions()` |
| `renderer/components/StatusBar.tsx` | add an `app.syncing` cell |
| `renderer/styles.css` | `.titlebar` height and padding; `.app.mac .titlebar` |
| `renderer/hooks/__tests__/menu-actions.test.ts` | new |
| `docs/design/2026-08-02-settings-panel.md` | §2.1's list of entry points rewritten |

## 3. Trade-offs

### 3.1 Why the title bar is thinned rather than deleted

The original intent was to delete the whole strip and let the first row be
content directly. It cannot be done, and the reason is structural, worth writing
down to save trying it again next time.

With the title bar deleted, the traffic lights must land in the window's
top-left corner, measured at **72×30px**. That patch of ground is exactly the
sidebar's first row. Three constraints then bite each other:

| constraint | source |
|---|---|
| A. delete the whole title bar | this change's request |
| B. the sidebar's collapsed state is a 28px strip | `2026-08-04-sidebar-collapse.md` §2.1 |
| C. the collapse/expand button lands on the same pixel | same document, measured over CDP, and the button was moved from the end of the header to the far left for it |

- **A + B** ⇒ when collapsed, the traffic lights (72px wide) do not fit in the
  28px strip; they overflow horizontally by 44px onto the tab strip of the
  top-left panel, and vertically onto the `›` on the strip.
- **A + C** ⇒ making `‹` and `›` share a pixel means pushing both below or to
  the right of the traffic lights, which conjures 30px of blank space at the top
  of the sidebar — the 34px saved get handed straight back, which amounts to
  having done nothing.
- **B + C** ⇒ exactly what exists today, at the price of keeping the title bar.

Giving up A is the cheapest of the three: B is the **entire** benefit of
collapsing the sidebar (collapsing exists to make way for wide tables, and
turning 28px into 72px makes it wider in the wrong direction), and C is an
interaction rule measured and nailed down only yesterday. Whereas A's benefit,
after §2.3's clear-out, is 4px of height — what is actually worth something is
"no more decoration and duplicated state at the top", and that part gets done
regardless.

The workarounds tried and found not to hold, recorded alongside:

- **When collapsed, use `setWindowButtonPosition` to move the traffic lights
  onto the tab strip of the top-left panel** (`PanelView` already has `index`,
  and `index === 0` is the depth-first top-left corner, so the test itself costs
  nothing). It breaks on split panes: `MIN_CHILD_PX` is 80px, and a 72px inset
  eats the entire tab strip of the narrowest panel. It also means syncing the
  sidebar's collapsed state to main — another channel opened to save 34px.
- **Move the traffic lights to the top-right corner.** Technically possible
  (`trafficLightPosition` takes any coordinate), but the top-right corner is the
  conversation rail's header, also 28px once collapsed, so the problem
  reproduces unchanged; and moving the close button out of the top-left corner
  trades the user's muscle memory for 34px.

### 3.2 Why the menu item carries an accelerator instead of being a menu item that shows no shortcut

The version without an accelerator costs nothing: `⌘,` stays with the renderer
and the menu item is just a clickable entry point — and a one-line `click`
callback still needs that IPC channel. **The channel cannot be saved; the only
thing saved is the accelerator.** And a mac application whose `Settings…` menu
item has no `⌘,` on its right reads as an application that does not have the
shortcut. Since the channel has to be built either way, the thing may as well be
finished.

### 3.3 Why non-mac keeps the gear rather than unifying all three platforms on the menu

On Windows / Linux, Electron's menu bar is either embedded at the top of the
window or not displayed at all (`menu.ts` currently hangs only `File → Quit` off
non-mac, which is nearly a placeholder). Putting settings in there means hiding
an entry point somewhere the user does not look. Mac's App menu is the canonical
location; the non-mac menu bar is not — **the canonical location for the same
action simply differs between the two platforms**, and following each one's own
convention matters more than the three platforms looking alike.

The price is one more platform condition in `App.tsx`. Exactly one.

## 4. Verification

### Automated (`pnpm test` / `pnpm typecheck`)

1. `renderer/hooks/__tests__/menu-actions.test.ts` (new):
   - after `applyMenuAction({ action: 'openSettings' })`,
     `useSettingsDialogStore.getState().section === DEFAULT_SETTINGS_SECTION`;
   - with the dialog already open on a different section, another message
     **returns it to the default section** — this has always been the semantics
     of `openSettings()` with no argument, and always been `⌘,`'s behaviour. The
     menu item inherits that chord on mac, so it has to inherit the behaviour
     along with it; this test guards the two against drifting apart, it does not
     claim the behaviour is the best one (the first version's assertion was
     written as "idempotent, stays on the section the user is on", and only on
     running it did the mismatch with the existing `⌘,` show up, at which point
     it was corrected to the existing behaviour);
   - a message of an unrecognised shape (`{ action: 'somethingNewer' }`) is
     dropped and does not throw.
2. `renderer/hooks/__tests__/shortcuts.test.ts` passes unchanged — `⌘,` still
   resolves to `openSettings` (non-mac still needs it).
3. `pnpm typecheck` fully green, including both implementations of `PeekBridge`
   (main world and degraded) having gained the new member.

### Measured (2026-08-04, CDP plus main's Node inspector, taken on the spot right after the change)

Two debuggers attached at once — the menu is in main and the dialog in the
renderer, and one port cannot reach both ends:

```
appClass            "app mac"
titlebar            height 30, padding-left 72px, app-region drag, 0 children, text ""
--bar-h             30px            (the title bar's height really does come from the variable, not another magic number)
first row top       30              (the sidebar header sits flush under the title bar, no gap left between them)
gears in window     0               (there really is none on mac)

peek menu           About / ─── / Settings… [Command+,] / ─── / Services / Hide / … / Quit
before clicking Settings…   dialog open: false
after clicking Settings…    dialog open: true, all six sections present
```

That is, `menu item → menuOpenSettings → IPC.MENU_ACTION → preload →
applyMenuAction → openSettings` is connected end to end. This script does not
enter the repository (a one-off check; the `verify-*.mjs` ones exist for
reproducible performance and data paths, and one menu item is not worth a
resident script).

**What it could not cover**: whether `⌘,`'s accelerator really does get ahead of
the renderer's keydown — that is AppKit's dispatch, and only a real key press
counts; and the traffic lights' visual landing point, because what CDP captures
is the web contents, and the native buttons are not in it. Both are in the
manual list below.

### Manual (macOS)

1. The menu bar's `peek → Settings…` exists, with `⌘,` shown on its right;
   clicking it opens the settings dialog.
2. Press `⌘,`: it opens the same way. **It must open with focus inside the
   CodeMirror query editor too** — that is the one behaviour that could have
   changed in moving from the renderer to a menu accelerator.
3. The title bar: only the traffic lights, no `peek` wordmark and no gear; the
   three lights are vertically centred in the 30px strip, neither flush to an
   edge nor clipped.
4. Dragging blank title bar space moves the window; double-clicking maximises it
   (`-webkit-app-region: drag` was not lost).
5. Before the first snapshot comes back, the status bar shows `Syncing state…`;
   start once with `mv out/preload out/preload.bak` and the status bar shows the
   preload-missing cell, and **only one cell**.
6. `FirstRunGuide`'s settings link (`mv ~/.peek ~/.peek.bak`) still goes
   straight to the MCP section.
7. Collapse the sidebar → the traffic lights and the `›` on the strip do not
   overlap (this is the scene of §3.1's deadlock, and it should still be fine
   after the change).

### Manual (Windows / Linux, or at least a code walkthrough when there is no machine)

8. The title bar still has the gear, and clicking it opens settings; `Ctrl+,`
   still opens settings; the title bar's left padding is no longer the 82px
   reserved for traffic lights.
