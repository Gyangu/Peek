# The conversation list: from a modal dialog to a permanent right-hand rail

> 2026-08-02. Trigger: the user pointed at the strip down the right of the window
> and said "I want conversation management to be a list on the right, right where
> my red box is. With collapse and expand buttons in the top right. Not the popup
> style it is now."
> This is a **revision** to §2.6 of the same day's
> `2026-08-02-chat-session-management.md`; that section's "dialog" conclusion is
> void, and every other section (commands, the identity model, the storage
> trade-off, the security boundary) is unchanged.

## 1. What this fixes

### 1.1 Where things stand

`ChatSessionsDialog` is a modal: `.modal-mask` covers the window, clicking the
mask closes it, and the list is capped at 320px with internal scrolling. It is
summoned by the status bar's "Conversations" button, and has to be dismissed after
one look.

### 1.2 The problem

**The conversation list is treated as a one-off query and is actually a standing
reference.** A modal's shape says "answer one question, then disappear" —
`ConnectDialog` and `McpSettingsDialog` are like that, and once a setting is
changed there is no reason to look again. The conversation list is not: the user
moves back and forth between several conversations, and looks at data panels while
doing so, and a modal makes those two things mutually exclusive — it either covers
the window or it is not there at all. The "Connections" rail on the left is the
same kind of thing (a list to be picked from repeatedly), and it is simply always
present.

**The mask makes "act while looking at the list" impossible.** Opening a second
historical conversation today means clicking the status bar button again, waiting
for the list to refetch, and clicking a row.

### 1.3 Conflicts with the existing design (checked)

| | `2026-08-02-chat-session-management.md` | here |
|---|---|---|
| §2.6 | the conversation list is a modal, summoned from the status bar's "Conversations…" | a permanent right-hand rail, with the status bar button becoming a toggle |
| §3.2 | argues for "a dialog, not a seventh view kind" | **conclusion unchanged**; see below |

That §3.2 trade-off is **unaffected**. What it argues against is promoting the
conversation list to a `kind: 'chats'` view — which would need a branch each in
`VIEW_KINDS`, `describeView`, `summarizeView`, `ViewHost`, `StatusBar`,
`context-actions/descriptors.ts` and MCP `open_view`'s schema, for a thing that
binds to no connection, holds no results, and takes no part in split or drag
semantics. A right-hand rail is a third route: like the dialog it lives outside
`VIEW_KINDS`, and merely **exists on screen a different way**. §3.2's argument
stands verbatim; only "therefore a dialog" becomes "therefore a rail".

### 1.4 Boundary (explicitly not done)

- **The data side does not change.** `chat.sessions.list` /
  `chat.sessions.delete`, staying out of the Workspace mirror, and titles going
  through `metaText` as untrusted text — not a line changes.
- **No width dragging.** The connection rail on the left is a fixed 240px and the
  right rail is symmetrical with it; another draggable edge means another piece of
  persisted state and a drag hit region, and what that buys is not worth the
  price.
- **No conversation search.** The original document's §1.3 already excluded it,
  and making the list permanent does not change that.
- **Nothing goes into the Workspace.** The collapsed state is a window preference,
  not a fact MCP needs to read; see §3.2.

## 2. The plan

### 2.1 Position: `.body`'s third column, not a floating layer

```
.app
├── .titlebar
├── .body            display:flex
│   ├── .sidebar        240px   connections
│   ├── .workarea       flex:1  LayoutTree (the panel tree)
│   └── .chat-rail      260px / 28px   ← new, symmetrical with .sidebar
└── .statusbar
```

In `App.tsx` that is
`<Sidebar /> <div className="workarea">…</div> <ChatSessionsRail />`.

**Not a floating layer**, because the red box in the screenshot sits right on top
of the rightmost panel's tab strip: the split and close buttons (`PanelTabs`) are
there. A floating layer either covers them or has to compute an offset to dodge
them, while a squeezing layout says it in one line of flex — the work area
narrows when the rail expands, the panels re-lay themselves out, and
`LayoutTree`'s percentage splits follow naturally with no notification needed.

### 2.2 Collapsing: a strip, not a disappearance

Collapsed, the rail narrows to 28px, leaving one expand button standing at the far
right; the work area takes back the rest.

**"Remove the whole rail when collapsed" was not chosen**: that would move the
expand entry point back to the status bar, putting one action in two corners of
the screen depending on state. The strip keeps the toggle button **always in the
same place**, and collapse and expand are two clicks of one button. 28px costs an
edge barely wider than a scrollbar.

### 2.3 Where the collapsed state lives

Renderer-local, in `localStorage` under `peek.chatRail.collapsed`, following the
shape of `i18n/store.ts` (a `try/catch` around both the read and the write —
production loads from `file://`, Chromium may refuse storage outright, losing a
preference is acceptable, and throwing during module initialisation and taking the
window with it is not).

The implementation is a zustand store in `components/chat/railStore.ts`, of the
same kind as `notifyStore`. Two places read and write it — the rail itself and the
status bar's toggle — so it is exported from `components/chat/index.ts`, and
`StatusBar` still imports only the directory's public face (the convention at the
top of `index.ts`).

**Not in the Workspace**: the Workspace is main's source of truth and what MCP
reads. Writing a rail's open/closed state there would tell main what the window
looks like, and would turn "collapse the right rail for a moment" into a revision
bump and a workspace change an AI has to interpret. The language switch stayed in
the renderer for exactly this reason (the doc comment in `i18n/store.ts` writes it
out), and the collapsed state is the same kind of thing.

The first run defaults to **expanded**: this change exists because the entry point
was too deep, and defaulting to collapsed would hide it again.

### 2.4 What the UI is made of

`ChatSessionsRail.tsx` replaces `ChatSessionsDialog.tsx` (deleted, not kept).
Fetching, the `open` mapping (indexed by both `resumeSessionId` and
`agentSessionId`), two-click deletion, `metaText` handling of titles, and
`formatWhen` all come across verbatim; only the shell changes:

- **Header** (reusing `.sidebar-head`'s look): the title "Conversations" plus `＋`
  (new), `⟳` (refresh) and `›` (collapse). The `›` sits at the far right, in the
  same position as the collapsed state's `‹`.
- **List**: `.session-list` loses `max-height: 320px` and fills the remaining
  height with internal scrolling — the height comes from the window now, not from
  a dialog's design figure.
- **Collapsed**: renders only the `‹` button, with `aria-expanded={false}`.

### 2.5 The status bar

Per the alignment:

- **"New conversation" stays.** It is the highest-frequency action, and burying it
  in a rail that has to be expanded first adds a click. The `＋` in the rail's
  header is a nearby duplicate, and both dispatch the same `view.open`.
- **"Conversations" changes from "open a dialog" to "toggle the right rail"**,
  with `aria-pressed` reflecting the current state.

## 3. Trade-offs

### 3.1 A rail, rather than keeping the dialog and adding one

**"Keep both" was not chosen.** One conversation list with two entry points and
two appearances means every future change has to be made twice, and they will
drift apart eventually — what drifts first is usually a corner behaviour such as
delete confirmation, which is exactly where two presentations are least welcome.

### 3.2 localStorage, rather than the Workspace

See §2.3. The costs are written down here so they are not mistaken for bugs
later: **no synchronisation across windows** (peek is single-window today, and
the original document's §1.3 already declared cross-window sharing out of scope),
and **MCP cannot see the rail's state** — which is deliberate, as
`read_workspace` should not gain a field unrelated to data.

### 3.3 A fixed width, rather than draggable

See §1.4. The left rail's 240px is the existing precedent; the right takes 260px,
because its rows carry one more timestamp than a connection row.

## 4. Verification

### 4.1 Automated

- i18n key consistency is covered by the two existing cases in
  `components/chat/__tests__/chat.test.ts` (matching keys and placeholders across
  both languages, and no English left untranslated in the Chinese catalogue) — the
  new `chat.sessions.collapse` / `expand` / `railToggleTitle` fall into them
  automatically.
- New unit tests for `railStore`: expanded by default; `toggle` persists to
  `localStorage`; a throwing `localStorage` read or write does not crash and falls
  back to the default (production is a `file://` origin, so this is not
  hypothetical).
- The conversation list's data-side behaviour does not change, and
  `bus/__tests__/chat-commands.test.ts` and `acp/__tests__/manager.test.ts`
  passing unchanged is the regression check.

### 4.2 UI (over CDP, needing no screen control)

The same method as the previous document's §4.3: start the build output with its
own `--user-data-dir` and `PEEK_MCP_PORT`, attach `--remote-debugging-port`, and
use `Runtime.evaluate` to read the DOM and click its own handlers. Measured and
passing (2026-08-02, with 27 real historical conversations):

1. The rail is expanded by default at `width: 260`, the work area shrinks from
   1172 to 940, and **27 rows** of real conversations are listed with
   agent-generated summaries as titles; the header's three buttons are
   `＋ ↻ ›`.
2. Clicking the header's `›` → `.chat-rail.collapsed`, `width: 28`, and the work
   area takes back 1172.
3. The status bar "Conversations" button's `aria-pressed` follows between `true`
   and `false`, and clicking it toggles the rail equally.
4. Clicking a row → the conversation is restored in the focused panel (with both
   the user's and Claude's turns in the transcript), **the rail does not close**,
   and that row immediately becomes "open" and disabled. The modal could not do
   this, and it is the point of the change.
5. **Survives a restart**: collapse → quit cleanly → reopen, `localStorage` reads
   `'1'`, the rail is collapsed at 28px, and the status bar's `aria-pressed` is
   false.

**This last one hit a trap, recorded so the next round does not spend the time
again**: "does not survive a restart" in the first few rounds was **a problem with
the verification method, not with the code**. Killing Electron with `pkill` leaves
a half-written record in that profile's
`Local Storage/leveldb/000003.log`, after which every start reports
`Corruption: checksum mismatch — dropping N bytes` and replays only up to the
corruption — so **every** subsequent write looks as though it never happened,
including the pre-existing `peek.locale`. The tell is leveldb's own `LOG` file.
With a fresh profile and a clean exit through CDP `Browser.close`, it passed
first time.
