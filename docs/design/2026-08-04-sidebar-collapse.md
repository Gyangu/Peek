# The connection sidebar can collapse

> 2026-08-04. Trigger: the user said "the connection sidebar should be
> collapsible".

## 1. What this fixes

### 1.1 Where things stand

`.body` is a three-column flex:

```
.sidebar     240px      connection list (fixed width, always present)
.workarea    flex:1     LayoutTree
.chat-rail   260px/28px conversation list, collapsible
```

`2026-08-02-chat-sessions-side-rail.md` §2.2 already made the right rail
"collapses to a 28px strip"; the left has no equivalent switch.

### 1.2 The problem

**Two rails of the same kind in one window, and only one of them gets out of the
way.** A data table is usually much wider than a conversation list: a 40-column
table already scrolls horizontally in a 1440-wide window, while the left rail
takes a fixed 240px. What the user wants is for the connection list to step aside
while looking at data, not to be deleted — there is nothing wrong with the
connection list, it just does not need to occupy width all the time.

### 1.3 Checked against the existing design

Two related documents were read, and there is **no conflict**:

| document | the relevant claim | overturned here? |
|---|---|---|
| `2026-08-02-chat-sessions-side-rail.md` §1.2 | "the connection rail on the left is the same kind of thing (a list to be picked from repeatedly), and it is simply always present" | **Not overturned.** That sentence argues the conversation list should be a permanent rail rather than a modal; the collapsed state is a 28px strip, not a disappearance, and the rail is still always present — the right rail does exactly this, and the left doing the same only strengthens the analogy |
| `2026-08-02-chat-sessions-side-rail.md` §1.4 | no width dragging | **Not overturned.** Collapse is a two-state switch, not a continuous width; still no drag hit region and no persisted width |
| `2026-08-02-connection-list.md` | the row model, label derivation, context menu | not involved, not a line changed |

### 1.4 Boundary (explicitly not done)

- **No width dragging**, for the reason above.
- **No keyboard shortcut.** The right rail does not have one either; build the
  button first, and if it genuinely feels slow, then it enters `shortcuts.ts` —
  which is a window-wide table where one more binding displaces a candidate.
- **No status bar switch.** The right rail has one in the status bar because it
  began life as a dialog opening from the status bar and the switch inherited
  that position. The left rail has no such history, and the 28px strip already
  guarantees the expand button is always on the same pixel (§2.2); a second entry
  point is two places to click for one action.
- **The connection list itself does not change**: the row model, the context menu
  and reading the connection book are all as they were.

## 2. The plan

### 2.1 The collapsed state is a 28px strip, copied from the right rail

```
.sidebar           240px       header: ‹  Connections        ＋
.sidebar.collapsed  28px       just a ›
```

The direction mirrors the right rail: the left rail collapses leftwards, so
collapse is `‹` and expand is `›`.

**The collapse button sits at the far left of the header, not the far right.**
The right rail's `›` is at the end of its header because the right rail's **outer
edge** is the right; the left rail's outer edge is the left, so mirrored it must
come before the title. This is not an aesthetic question, it is §2.1's own rule:
a first version was built with it at the end "like the right rail", and CDP
measured the collapse button at x=207 and the expand button at x=0 — a 200px jump,
which is exactly what this rule exists to avoid. Moved to the far left, both
states land in the same 28px column (x=8 expanded, x=0 collapsed, a padding
apart, the same order of offset as the right rail's).

The reasoning in `2026-08-02-chat-sessions-side-rail.md` §2.2 for "not removing
the strip entirely" applies verbatim: removing it entirely moves the expand
entry point elsewhere, putting one action in two places on screen depending on
state.

### 2.2 Where the collapsed state lives

Renderer-local, in `localStorage` under the key `peek.sidebar.collapsed`,
defaulting to **expanded**.

Not in the Workspace, for the same reason as the right rail (that document's
§2.3): the Workspace is main's source of truth and what MCP reads, whereas a
rail opening and closing is window chrome. Writing it there would tell main what
the window looks like, and would turn "collapse the left rail for a moment" into
a revision bump.

The implementation goes in `renderer/state/sidebarStore.ts`, alongside
`settingsDialogStore.ts` (both renderer-local window chrome state) rather than
next to the component the way `railStore.ts` is — `chat/` is a directory with a
public face in `index.ts`, and `Sidebar.tsx` is not.

### 2.3 Folding the localStorage try/catch into one place along the way

`i18n/store.ts` and `chat/railStore.ts` each write out "wrap both the read and
the write in try/catch, because production loads from `file://` and Chromium may
refuse storage outright". This change would be the third, so it is extracted into
`readFlag` / `writeFlag` in `renderer/state/persistedFlag.ts` (booleans only),
with `railStore` switching to it and `sidebarStore` using it directly.

`i18n/store.ts` **does not change**: it stores a `Locale` rather than a boolean
and has to initialise synchronously before React mounts. The shape is different,
and forcing it in produces a generic that suits neither. That one duplication
stays, at the cost of a comment.

### 2.4 Header layout

The header now has three children (title, ＋, collapse), and
`justify-content: space-between` would fling the ＋ into the middle of the title's
white space — the right rail hit this long ago and overrode it to `flex-start`
plus `gap` with `.chat-rail .sidebar-head`. Since both users need that behaviour,
it is lifted into the base `.sidebar-head` rule and the right rail's override is
deleted; the title takes `flex: 1` to absorb the remaining width (a new
`.sidebar-title`, shaped like `.chat-rail-title`).

### 2.5 Collapsing with an empty list

With zero connections the sidebar draws `FirstRunGuide`, and collapsing hides it
along with everything else. **Accepted**: the expand button on the strip is right
there, and "the user deliberately collapsed the guide while having no
connections" is itself a clear statement. No "collapsing is forbidden at zero
connections" — that decides for the user, and needs a special case written in two
places.

### 2.6 Files involved

| file | change |
|---|---|
| `renderer/state/persistedFlag.ts` | new: `readFlag` / `writeFlag` |
| `renderer/state/sidebarStore.ts` | new: the collapsed-state store |
| `renderer/components/chat/railStore.ts` | switches to `persistedFlag` |
| `renderer/components/Sidebar.tsx` | collapse button in the header; collapsed renders only the expand button |
| `renderer/components/chat/ChatSessionsRail.tsx` | title class becomes the shared `.sidebar-title` |
| `renderer/styles.css` | `.sidebar.collapsed`, `.sidebar-handle`, `.sidebar-head` layout lifted, `.chat-rail .sidebar-head` deleted |
| `renderer/i18n/messages/{en,zh-CN}/sidebar.ts` | new `sidebar.collapse` / `sidebar.expand` |
| `renderer/state/__tests__/sidebar-store.test.ts` | new |

## 3. Trade-offs

**Why not a draggable width.** Collapsing solves "get out of the way"; dragging
solves "tune it to just right". The latter needs a persisted continuous value, a
drag hit region, and a pile of minimum/maximum edge cases, while two states are
enough for what was asked. The right rail's §1.4 already gave the same answer to
the same question, and two rails should not have two sets of logic.

**Why not reuse `railStore` and add a field.** Collecting "window chrome collapse
state" into one store sounds economical, but it makes a module under
`components/chat/` a dependency of `Sidebar.tsx` — and the chat directory's
public face should only be chat. What is shared is the try/catch layer over
localStorage, not the state.

**Why no keyboard shortcut or status bar switch.** See §1.4. The collapsed
strip already answers "how do I open it again" definitively; a second entry point
buys no discoverability and adds two places to keep in sync.

## 4. Verification

Automated (`pnpm test`):

1. `renderer/state/__tests__/sidebar-store.test.ts` (new), following
   `rail-store.test.ts`'s five cases: expanded by default; a stored `'1'` stays
   collapsed across a restart; toggling persists in both directions (expanding
   writes `'0'` rather than deleting the key); setting an existing value does not
   write; a throwing storage does not crash and the session still follows along.
2. `rail-store.test.ts` passes as it was — that is, extracting `persistedFlag`
   changed no right-rail behaviour.
3. `i18n/__tests__/i18n.test.ts` covers the two new keys (matching keys and
   placeholders across both languages).
4. `ui/__tests__/control-spec.test.ts` passes: `.sidebar-handle` declares layout
   properties only (`width`) and paints no colour.
5. `pnpm typecheck` all green.

By hand:

1. Click `‹` in the header → the left rail collapses to 28px and the work area
   widens; click `›` on the strip → back to 240px.
2. Collapse → quit cleanly (not `pkill`; see the leveldb trap in the right rail's
   §4.2) → reopen, and the left rail is still collapsed.
3. Connect a database while collapsed (from MCP or an open query panel); expand
   and that row's status dot is green — collapsing did not break reading the
   connection book.
4. Collapse both rails at once: the work area gets almost the entire window
   width, with a strip on each side.
