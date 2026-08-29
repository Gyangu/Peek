# The settings page: collecting scattered preferences into one place

## 1. What this fixes

### Where things stand

peek's configuration currently lives in three places, each of them parasitic on
something else's context:

| setting | entry point | problem |
| --- | --- | --- |
| the MCP endpoint (port, token) | the gear on the sidebar's Connections header row | a gear growing out of the Connections header row announces "these are the connection settings" — but what it manages is the MCP endpoint, which has nothing to do with connections |
| interface language | the cycling button at the right of the status bar | the status bar is where "what is happening right now" goes, not "what I want to change" |
| query / connection timeouts | no entry point | `getTimeoutSettings` / `setTimeoutSettings` have long been ready, but there is no form and nothing is written to disk, so a change does not survive a restart (an open item in PLAN.md) |

All three work, but not one of them answers "what is there in peek that can be
adjusted". And that question only gets sharper: the timeouts have to come in, and so
will future layout persistence, the write-operation switch and the result-set ceiling.

### The conflict with an existing document

`docs/PLAN.md` §7, verbatim:

> The settings panel (the sidebar gear) is responsible for changing the port and
> rotating the token.

That sentence hard-codes the entry point's location into the sidebar. This change
overturns it — the gear leaves the sidebar, and PLAN.md is updated to match. Confirmed
with the user (2026-08-02).

### Boundary (not done this time)

- **The locale's storage location does not change.** Language remains a renderer-local
  preference kept in `localStorage`; it does not enter the Workspace and does not enter
  `settings.json`. The reason is in the comment at the top of `i18n/store.ts`: the
  Workspace is main's source of truth and is what MCP reads, so stuffing "which language
  is the human reading" into it means asking the AI to reason about a variable that has
  nothing to do with it. This change moves the UI's location only, not the storage.
- **No per-connection timeout override.** `setConnectionTimeouts` is already
  implemented, but it belongs to the connection edit dialog, not the global settings
  page. See §3.3.
- **The stage timeouts are not exposed** (`readyMs` / `connectMs` / `rpcMs` and the
  rest of the 9). See §3.2.
- **No theme switching.** There is only one dark theme today, so the Appearance category
  starts with language alone.

## 2. The plan

### 2.1 Shape and entry points

**Shape**: a modal dialog, a single column of category navigation on the left and the
corresponding form on the right. What VS Code and Slack do.

**Entry points**:
- a gear button at the right of the title bar (`App.tsx`'s `.titlebar`, which needs
  `no-drag`)
- the `⌘,` / `Ctrl+,` global shortcut
- `FirstRunGuide`'s `onOpenSettings` changed to open the MCP category directly

> **Rewritten by `2026-08-04-settings-into-app-menu.md` (2026-08-04)**: on macOS the
> entry point is **the App menu's `peek → Settings…`**, the gear is removed from the
> title bar, and `⌘,` is carried by that menu item's accelerator (the action comes back
> to the renderer over a new `IPC.MENU_ACTION` channel). Windows / Linux keep what is
> written here — the gear plus `Ctrl+,`. The `FirstRunGuide` line is unchanged on both
> platforms.
>
> This section's claim that "settings belong to the window, not to a connection or a
> panel" is unaffected: the App menu is equally a window-level surface, and it is the
> canonical place for settings on macOS. What changed is the list of entry points, not
> the reason for picking it.

**Entry points removed**:
- the gear on the sidebar's Connections header row (`Sidebar.tsx`)
- the language cycling button in the status bar (`LanguageSwitch` in `StatusBar.tsx`)

### 2.2 Categories

Four in the first version:

1. **MCP endpoint** — everything currently in `McpSettingsDialog`, moved across as it
   is (status, address, showing / copying / rotating the token, the port, the
   `claude mcp add` command). Pure relocation, zero new logic.
2. **Appearance** — language selection. It changes from the status bar's "cycle
   through" to an explicit set of options; the locale names are still self-named
   (`English` / `中文`) and never go through `t()`.
   > **Extended by `2026-08-02-ui-legibility-baseline.md` §2.4**: this category now also
   > has **interface scaling** (a whole-page `zoomFactor`, stored as `uiZoom` in
   > `settings.json`). The "no theme switching" boundary below is unaffected — scaling
   > is not a theme.
3. **Queries and timeouts** — the three execution timeouts: `queryMs` / `scanMs` /
   `vectorSearchMs`. The unit in the interface is **seconds**; what is stored is
   milliseconds. `0` means no ceiling, which is `resolveExecutionTimeout`'s existing
   semantics, and the interface says so plainly.
4. **About** — the version number and the absolute paths of each config file under
   `~/.peek`. So that "where is my configuration" has somewhere to be looked up.

### 2.3 Files

New:

```
apps/desktop/src/renderer/components/settings/
  index.ts                      exports SettingsDialog and nothing else
  SettingsDialog.tsx            the modal shell + category navigation
  McpSection.tsx                moved from McpSettingsDialog (modal shell removed)
  AppearanceSection.tsx         language
  TimeoutsSection.tsx           execution timeouts
  AboutSection.tsx              version and paths
apps/desktop/src/renderer/state/settingsDialogStore.ts
apps/desktop/src/renderer/i18n/messages/{en,zh-CN}/settings.ts
```

Deleted: `apps/desktop/src/renderer/components/McpSettingsDialog.tsx`

Changed:

| file | what changes |
| --- | --- |
| `components/App.tsx` | add the gear to the title bar; mount `SettingsDialog` |
| `components/Sidebar.tsx` | delete the gear and the `settings` state; `FirstRunGuide`'s callback goes through the store |
| `components/StatusBar.tsx` | delete `LanguageSwitch` |
| `hooks/shortcuts.ts` | add the `openSettings` action, bound to `⌘,` / `Ctrl+,` |
| `hooks/useGlobalKeys.ts` | `openSettings` → call the store, do not issue a Command |
| `i18n/messages/*/sidebar.ts` | `mcp.*` and `sidebar.settings` move to the new `settings.ts` domain |
| `i18n/messages/*/index.ts` | register the new domain |
| `i18n/messages/*/app.ts` | `app.language.title` moves out |
| `packages/core/src/commands.ts` | add `settings.read` / `settings.write` |
| `apps/desktop/src/main/config/settings.ts` | `PeekSettings` gains `executionTimeouts` |
| `apps/desktop/src/main/config/handlers.ts` | implement the two new commands + the degraded implementation |
| `apps/desktop/src/main/index.ts` | feed the persisted timeouts to `setTimeoutSettings` at startup |
| `renderer/styles.css` | the settings page's two-column layout |

One constraint hit during implementation, written down so it is not hit again:
`config/handlers.ts` must **import `../connections/timeouts` directly** to get the
timeouts, and must not go through the `../connections` barrel. The barrel re-exports
`host-process.ts`, which does `import { app } from 'electron'`, and so the whole group
of config handlers fails to load in a pure Node test (`does not provide an export named
'app'`). `timeouts.ts`'s own contract is "touches no file and no Electron", so pointing
straight at it both works and is more honest.

### 2.4 Where the dialog's open state lives

In `state/settingsDialogStore.ts`, a renderer-local external store, in the same vein as
`notifyStore` and the i18n store:

```ts
openSettings(section?: SettingsSection): void
closeSettings(): void
useSettingsDialog(): SettingsSection | null   // null = closed
```

**Why not a `useState` lifted to `App`**: `⌘,` is handled by `useGlobalKeys`, an effect
hung on `window`, which cannot reach a setState inside the React tree unless the setter
is threaded all the way down or a context is added.

**Why not a Command / the Workspace**: every action in `useGlobalKeys` issues a Command,
and that is deliberate — the keyboard is drag-and-drop's accessible twin and goes down
the same road. But "is the settings dialog open" is not Workspace state: it changes no
persistent fact, MCP cannot read it and should not, and it is the same kind of thing as
the locale. Having the AI "open the settings panel" is meaningless — an AI that wants to
change the port just issues `mcp.configure`.

### 2.5 The new commands

```ts
'settings.read'   →  { execution: ExecutionTimeouts, paths: SettingsPaths, version: string }
'settings.write'  →  { execution: Partial<ExecutionTimeouts> } → { execution: ExecutionTimeouts }
```

Both are `read` handlers (they do not touch the Workspace, do not bump the rev, do not
broadcast a patch), exactly isomorphic to `mcp.read` / `conn.book.*` — what they operate
on is a file, not window state.

`settings.write` does two things in a fixed order: first `setTimeoutSettings(patch)` so
it takes effect immediately, then writes **the values that actually took effect** into
`settings.json`. The other order would write invalid values to disk —
`setTimeoutSettings`'s contract is "an invalid entry is discarded rather than thrown",
so only its return value is the truth.

`version` and `paths` are crammed into the same command as the timeouts because they
answer the same question: "what does this installation look like". Splitting them into
two commands would only cost the About page an extra round trip.

### 2.6 Persistence

`PeekSettings` gains one optional field:

```ts
export interface PeekSettings {
  mcpPort?: number
  /** Execution timeouts, in milliseconds. Only keys the user explicitly changed. */
  executionTimeouts?: Partial<ExecutionTimeouts>
}
```

Only changed keys are stored; the defaults are not materialised — consistent with the
handling of `mcpPort`, and for the same reason: when a default is adjusted later, a user
who never touched the setting should move with it.

In startup order, `setTimeoutSettings(persisted)` must be called **before** any
connection is established. It is hung next to `buildMcpController` (both after
`configDir` is ready and before `createWindow()`).

## 3. Trade-offs

### 3.1 A modal dialog, rather than its own view or its own window

**Its own view was considered** (`view.kind = 'settings'`, able to enter the
`LayoutTree`, to be split, and to be opened remotely by MCP). The attraction is reusing
the entire layout capability. Why not: settings are an "open it, change it, close it"
thing, and the scenario of putting them side by side with a data view barely exists;
whereas making it a view means answering "what happens when the same settings view is
open twice" and "should it take part in layout persistence" — problems entirely of one's
own making.

**A separate Electron window was considered** (the most macOS-native of the options).
Rejected because it needs a new `BrowserWindow`, a second preload/IPC assembly and
window lifecycle management, which is plainly too heavy at the current size.

A modal, by contrast, is almost free: `.modal-mask` / `.modal-head` / `.modal-body` /
`.form-row` are already there, and `McpSettingsDialog`'s content works as soon as it is
moved across whole.

### 3.2 Exposing 3 execution timeouts, not 9 stage timeouts

`TimeoutSettings` has 12 fields. The stage timeouts (spawn→ready, connect RPC, cancel
RPC…) constrain a single leg of the driver-host protocol; they are the **protocol's
internal self-protection**, not a user preference — which is exactly how `timeouts.ts`'s
own comment divides them. Putting `cancelMs` on screen would only get somebody to set it
wrong under the impression they were tuning performance.

Execution timeouts are different: "how long may this query run" is the user's judgement
about their own database, and only the user knows it.

If somebody one day genuinely needs to adjust a stage timeout, `settings.json` can be
edited by hand — `SettingsStore` preserves unknown keys, so that road is open anyway.

### 3.3 Global preference first, no per-connection override

The question PLAN.md left open was "a global preference or a per-connection override".
The answer is **both, but global first**:

- the global value is every connection's starting point; without it a per-connection
  override has nothing to override;
- a per-connection override's correct home is **the connection edit dialog**
  (`ConnectDialog`), not the global settings page — "queries in this repository take a
  few minutes" is a fact about that connection and belongs written down beside its host
  and port. Putting it in the global settings page would force a connection picker into
  existence, which is rebuilding the connection list inside the settings page.

So this round lands the global one only, and the per-connection one is left to a later
change to `ConnectDialog`.

### 3.4 Language moves out of the status bar, with no shortcut left behind

That status bar button switches on one click, which is faster than going into the
settings page. Moving it does cost something.

It was moved anyway, because **one setting with two entry points will drift sooner or
later**: the status bar cycles (least effort with two languages), the settings page
selects explicitly (the only thing that is right with three). Keep both, and the moment
a third language arrives the cycling button becomes an odd thing that takes two clicks
to get where you are going. If a shortcut is really wanted, its correct form is a
keyboard shortcut for the settings page (there already is one, `⌘,`), not a back door
opened for one individual setting.

### 3.5 Seconds in, seconds out; milliseconds in, milliseconds out

Timeouts are seconds in the interface, and milliseconds in storage and transport. Nobody
wants to count the zeros in `120000` in a form. The conversion happens only at
`TimeoutsSection`'s input and output; the command and the storage layer are milliseconds
throughout — milliseconds are `timeouts.ts`'s unit, and making it change unit somewhere
in transit is trouble invented for its own sake.

## 4. Verification

### Automated

- `packages/core/__tests__/commands.test.ts` — schema validation for the new commands
  (negative, non-integer, above the ceiling, empty patch)
- `apps/desktop/src/main/config/__tests__/settings.test.ts` — the read/write round trip
  for `executionTimeouts`; unknown keys still preserved after a write; invalid values
  not written to disk
- `apps/desktop/src/main/config/__tests__/handlers.test.ts` — `settings.write` takes
  effect before it writes; what is written is `setTimeoutSettings`'s return value, not
  its argument
- `apps/desktop/src/renderer/hooks/__tests__/shortcuts.test.ts` — `⌘,` / `Ctrl+,`
  resolves to `openSettings`; it **still** fires inside a text input (it conflicts with
  none of CodeMirror's bindings)
- `apps/desktop/src/renderer/i18n/__tests__/i18n.test.ts` — the existing key-set
  alignment test covers the new domain automatically, provided both catalogues gained
  the keys (the compiler will also stop you)

### Manual

1. `⌘,` opens the settings; all four categories can be opened; `Esc` and a click on the
   mask both close it.
2. MCP category: change the port → apply → copy the command → it prompts to re-register.
   Behaviour identical, word for word, to before the move.
3. Appearance category: switch to Chinese and the entire window (the settings page
   included) becomes Chinese immediately; still Chinese after a restart.
4. Timeouts category: set the query timeout to 5 seconds → close the settings → run a
   slow query → it times out after 5 seconds; **restart peek → go back to the settings
   page and confirm it is still 5 seconds** (this one is the crux of the whole change;
   before it, this did not survive a restart).
5. Set the timeout to 0 → the slow query no longer times out.
6. About category: the paths do open to something that exists (`ls` one).
7. First run (`mv ~/.peek ~/.peek.bak`): `FirstRunGuide`'s settings link goes straight
   to the MCP category.
