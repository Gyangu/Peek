# A single click opens a session row, and the "provisional tab"

## 1. What this fixes

The gesture that opens a conversation in the right-hand rail
(`ChatSessionsRail`) today is a **double click** on the row, with the discoverable
entry point being "Open" in the context menu. The permanent "Open" button that
used to sit in the row was removed by
[`2026-08-03-context-menu-primitive.md`](2026-08-03-context-menu-primitive.md).

Three problems, connected:

1. **The primary action is hidden in a double click.** This row has no second
   single-click meaning — the connection list reserves the single click for
   "select and reveal the action bar", which is why "single click selects, double
   click connects" is justified *there*; a session row has no selected state and no
   action bar, so a click on the row is a pure no-op.
2. **Once a click is cheap, tabs accumulate.** `onOpen` calls `view.open`
   unconditionally (defaulting to `replace: false`), so clicking five rows in the
   rail produces five tabs, four of which were merely glanced at.
3. **The keyboard cannot reach this rail at all.** `.session-item` is a bare `div`
   with no `role` and no `tabIndex`, and the context menu opens only with a mouse.
   In the double-click era that was merely "the accelerator is unreachable"; once a
   single click becomes the primary entry point, the whole rail becomes
   mouse-only.

**Not done**: the delete confirmation is untouched; the connection list's "single
click selects, double click connects" is untouched (there the single click has
something to do, so it is not the same structure); and no multi-select on session
rows.

## 2. Conflicts with existing documents (checked; this document is the new source of truth)

| document | old conclusion | here | verdict |
|---|---|---|---|
| `2026-08-03-context-menu-primitive.md`, verification item 8 | "a double click on the row still opens the session" | single click opens (provisional), double click opens (pinned) | **overturned**. The goal then was only "opening is still reachable after removing the in-row button", and double click was the cheapest thing to keep |
| `2026-08-02-chat-sessions-side-rail.md`, verification item 4 | "click a row's 'Open' → …" | "click a row → …" | **narrowed**. That sentence describes an in-row button that no longer exists |
| `2026-08-02-chat-sessions-side-rail.md`, on already-open rows | "becomes 'open' and is **disabled**" | still reads "open", but clicking jumps to it | **overturned**. See §3.4 |

## 3. The plan

### 3.1 In one sentence

**A single click opens provisionally, a double click opens pinned. There is only
one provisional tab, and the next provisional open reuses its position; it is
marked in italics on the tab strip, and any action by the user that says "I am
going to use this" promotes it.**

These are VS Code's preview tab semantics, chosen because they are the only
widely validated solution to this problem, and because the user probably already
knows them. What matters is not the replacement itself but its three
preconditions:

- **the state is visible** (the italic label), not a history the user cannot see;
- **promotion is an explicit action by the user**, not a guess by the system;
- **rules map one-to-one onto gestures**, so one gesture always does one thing.

The version this replaces was "replace the previous chat if it was never actively
engaged with". That rule's behaviour is in fact close to this one, but it hid its
state in a ref in the renderer: nothing on screen distinguished "a tab that will be
displaced" from "a tab that will not", so the user could neither predict it nor
deliberately pin a conversation. A rule that cannot be learnt and cannot be
controlled is far worse than a few extra tabs.

### 3.2 The provisional state lives in the Workspace, not the renderer

`ViewBase.provisional?: true`. The reasoning is the same as the reasoning that
pushed `activeViewId` down: the tab strip has to draw it, `view.open` has to find
it, and sending a message has to clear it, and all three must see the same answer;
in the renderer it would be a second source of truth. It is therefore also visible
to MCP — an AI reading the workspace can tell which tab the user was merely
skimming.

Contract changes (`packages/core`):

| location | change |
|---|---|
| `ViewBase` | adds `provisional?: boolean` |
| `ViewOpenInput` | adds `provisional?: boolean` (defaults to false) |
| a new `view.promote` command | `{ viewId }` → clears that view's `provisional` |

`view.promote` is its own command rather than a patch field on `view.update`:
`ViewPatch` is a union discriminated by `kind`, and adding a kind-independent field
means writing it into all six branches while they all express one thing. Nor is it
folded into `view.activate` — "show it" and "keep it" are two intentions, and one
click may carry only the first.

### 3.3 The replacement happens in main

When `view.open` receives `provisional: true`, it first looks for an existing
`provisional` view: if there is one, it closes it and takes its tab position
(equivalent to a `replace` on that panel), and otherwise it appends as usual. So
"at most one provisional tab" is an invariant of the Workspace itself rather than
something the session rail remembers — opening provisionally from elsewhere (a
future history list, or an AI) behaves identically.

**Four triggers for promotion**, all of them explicit user actions:

| action | why it counts as "I am going to use this" |
|---|---|
| double-clicking a session row | opens with `provisional: false` directly |
| double-clicking the tab | the pinning gesture, consistent with editors |
| sending a message in this conversation | the strongest signal: the user has invested content |
| dragging the tab somewhere | arranging it is keeping it |

The first three are implemented here; dragging is left for the next time
`dragMachine` is touched, recorded here so it does not get lost.

**A conversation mid-stream is never replaced**: `closeChat` calls `cancel()` for a
streaming session
([manager.ts:523](../../apps/desktop/src/main/acp/manager.ts)), so closing it
throws away an answer being generated. So main skips any chat with
`streamingMessageId !== null` when choosing a replacement target, promoting it in
place and opening the new one in another tab.

This branch is normally unreachable from the UI — sending a message promotes it, so
"provisional and mid-reply" is a contradiction. It exists because
`view.open provisional` is a public command and the MCP side can open provisional
views too, and on that path both can hold at once. It is a defence, not the main
path.

**A conversation still loading, however, can be replaced**: restoring a historical
session runs a `session/load`, and closing it partway merely wastes that run — not a
word of the transcript on disk is lost. Making an exception for it would let
"clicking several rows before any of them finish loading" accumulate tabs again,
which is the problem being solved.

### 3.4 An already-open row: clicking jumps to it

Today, clicking an "open" row does nothing. The user's intention is "I want to see
that conversation", not "I want another one", so it now calls
`view.activate({ focusPanel: true })`. The "open" reading on the row stays — it now
says **where a click will take you**, rather than "this row is broken".

### 3.5 Keyboard and accessibility

The session list becomes a `listbox`, with each row an `option`:

- one tab stop for the list (roving `tabIndex`), with `↑ ↓ Home End` moving between
  rows;
- `Enter` = a single click (open provisionally), `⌘Enter` / `⇧Enter` = a double
  click (open pinned);
- `Delete` / `Backspace` delete, still through the same confirmation as the context
  menu;
- `aria-selected` follows the keyboard cursor, and "open" and "provisional" are
  spoken through `aria-describedby` rather than relying on italics as a purely
  visual encoding (the same constraint as `ui-legibility-baseline.md`'s "no encoding
  by colour or typeface alone").

### 3.6 Visuals

On the tab strip, a `provisional` title is italic
(`.panel-tab.provisional .tab-title { font-style: italic }`), with a `title`
attribute adding "provisional tab — double click to pin". Italics is the editors'
existing language, and it occupies no space and does not change the tab's width, so
the tab strip does not jump at the instant of promotion.

### 3.7 Files involved

| file | change |
|---|---|
| `packages/core/src/workspace.ts` | `ViewBase.provisional` |
| `packages/core/src/commands.ts` | `ViewOpenInput.provisional`, the `view.promote` command and result |
| `apps/desktop/src/main/bus/handlers/shared.ts` | `openView`: choosing a replacement target, writing `provisional` |
| `apps/desktop/src/main/bus/handlers/view.ts` | `view.promote` |
| `apps/desktop/src/main/bus/handlers/chat.ts` | clearing `provisional` on send |
| `apps/desktop/src/renderer/components/chat/ChatSessionsRail.tsx` | single/double click, listbox, open = activate |
| `apps/desktop/src/renderer/components/PanelTabs.tsx` | italics, double click to promote |
| `apps/desktop/src/renderer/styles.css` | `.panel-tab.provisional`, the row's focus ring |
| `apps/desktop/src/renderer/components/chat/sessionKeys.ts` | the cursor's pure functions (new) |
| `apps/desktop/src/renderer/ui/useContextMenu.ts` | `openAt`, so the keyboard can open the menu |
| `i18n en / zh-CN` | new copy |

**No MCP tool is added for `view.promote`.** The command itself is open to MCP (the
same bus), and what is missing is only a dedicated tool — and "pin a tab" is not
something an AI needs to do, since the views it opens are pinned by default. Add it
when there is a need, rather than building it in advance.

## 4. Trade-offs

**Why not "unconditionally replace the focused panel's active view".** That would
close a table while the user is looking at it, and the session rail coexisting on
screen with a table panel is the entire reason this rail exists.

**Why not "only replace a blank new conversation that has never been sent to".**
That blocks one way of accumulating tabs; clicking five **historical** sessions in
the rail still accumulates five tabs, and that is this rail's most common use.

**Why not "do not replace, and let the user close them".** That transfers the
cleanup cost to the user, and `MAX_PANEL_TABS` is 12 — skimming a dozen or so
conversations hits the tab ceiling and raises an error, turning a browse into a
fault.

**Why the provisional state is not a separate preview area outside the tab
strip.** That is a seventh view container, and it would have to negotiate heights
with the virtual scroller (the note at the top of `PanelTabs`), for a benefit of
saving one tab slot.

**Why the double click survives (as "open pinned" this time).** The previous
version judged that a double click is "opening twice, which is noise" — that was
without a provisional state. With one, the double click has a meaning of its own,
and one consistent with editors.

**Why there is one provisional tab globally rather than one per panel.**
"Provisional" describes the user's attention, and a person has only one. One per
panel would let a user with a split layout accumulate N provisional tabs, which is
the problem being solved.

## 5. Verification

Automated (`npm test`):

1. `view.open` with `provisional` twice → the second closes the first and takes its
   tab position, leaving one tab in the panel;
2. `view.open` without `provisional` twice → two tabs (a regression check; the old
   behaviour is unchanged);
3. `view.open provisional` while the provisional view is streaming → **no**
   replacement, two tabs, and the first has had its `provisional` cleared;
4. `view.promote` → `provisional` is gone, and a subsequent provisional open does
   not touch it;
5. `chat.send` in a provisional chat → `provisional` is gone.

By hand:

6. Click three different session rows in a row → the panel holds exactly one
   conversation tab throughout, its title italic, its contents replaced in turn;
7. Double click the fourth row → the tab becomes upright; then click the fifth row →
   a **new** italic tab appears and the fourth is still there;
8. Single click a row → immediately send a message in it → the tab is promoted; then
   click another row in the rail → a new one appears;
9. Click a row → click another while it is still loading → the first is **not**
   cancelled, and both tabs are present;
10. Click an "open" row → it jumps to that tab and focuses its panel, opening
    nothing new;
11. Keyboard only: Tab to the session list → `↓↓` → `Enter` opens provisionally →
    `⌘Enter` opens pinned → `Delete` goes through the delete confirmation; a visible
    focus ring throughout.
