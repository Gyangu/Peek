# The interface legibility baseline: type size, contrast, hit area, and the shape of three dangerous actions

> 2026-08-02. Trigger: the user asked for "an adversarial review of the UI's size,
> its typography, and whether the human interaction is reasonable". The review's
> conclusion is that the direction — density — holds, but that it is missing a
> **floor**; density with no floor walks all the way down to 9px and 2.5:1, and
> those two numbers are this round's measurement of where things already stand.
> This document gives that floor a definition that can be checked, and revises the
> three earlier conclusions it overturns (see §1.3).

## 1. What this fixes

### 1.1 Where things stand

`styles.css` opens by stating this theme's direction:

> dark theme at the compact density of a data tool (the TablePlus / Beekeeper feel)

The direction is fine. The problem is that it has no bottom. Measured across the
repository:

**Type has four tiers, and the lowest is 9px.**

| size | where |
|---|---|
| 12px | the `body` baseline |
| 11px | sidebar headers, the line-number gutter, table headers, the status bar, `tree-detail`, the great majority of secondary text |
| 10px | `.conn-driver`, `.ctype`, `.tree-icon`, `.tab-close`, `.chat-tool-badge`, `.md-pre-lang`, `.chat-attach-label`, `.chat-plan-status`, session-row timestamps |
| **9px** | `.conn-key`, `.tree-caret`, `.md-check` |

macOS's system UI bottoms out at 11px (caption2). peek has an entire tier below
that, and peek is a **product that ships zh-CN** — PingFang SC's strokes run
together at 10px. `.chat-tool-badge` is 10px, and what it carries is "this tool
call is about to change your data".

**`--fg-faint` cannot be read on any background.** Measured (WCAG 2.1, 4.5:1 for
body text):

| combination | contrast |
|---|---|
| `--fg-faint` on `--bg` | **2.88** |
| `--fg-faint` on `--bg-1` | **2.70** |
| `--fg-faint` on `--bg-2` | **2.49** |

Whereas `--fg-dim` (5.31 on `--bg-1`) and `--fg` (12.40 on `--bg`) are both
healthy. Which is to say only the palette's last step is broken — **and it is
exactly the step assigned to the smallest tier of type**. 10px × 2.49:1 is not
"understated", it is invisible.

**Non-text contrast bottoms out just as badly.**

| element | contrast | note |
|---|---|---|
| `--border` vs `--bg` | 1.32 | cell grid lines, panel borders |
| `--border-strong` vs `--bg-1` | 1.62 | **input borders** |
| the self-drawn vertical scrollbar thumb (`fg-faint` @ .4) | 1.46 | the **only** vertical navigation object in a million-row table |
| the same, hover / dragging | 2.28 | |
| row selection (accent @ .18) | 1.33 | |
| zebra striping `#191c20` | 1.04 | the same as not drawing it |

The scrollbar row is the worst of them: the native vertical scrollbar was taken
away by `overflow-y: hidden` (`vscroll.ts`'s 16.7M px ceiling — that decision is
right), and what stands in for it is a 1.46:1 bar carrying `cursor: default` — a
draggable object telling the cursor outright that it is not interactive.

**Hit areas are broadly below the floor for a desktop pointer.** `button`
computes to 23.4px tall (12px × 1.45 + padding 4 + border 2); `.tab-close` is
16×16; `.tree-action` is 16 tall; `.chat-chip-x` is about 14×14. `.statusbar` is
22px tall and yet holds a 23.4px button under `overflow: hidden`, so the button is
clipped top and bottom.

**Interface zoom does not exist.** The "Appearance" category holds nothing but
language. The one path to making things bigger is Electron's **never-customised
default menu** — which hands the end user `⌘R` Reload and DevTools at the same
time, and in a data tool `⌘R` is a key you hit by slipping.

### 1.2 Three dangerous shapes on the interaction side

Three findings in the review are not about "size" but are about "reasonable":

1. **The permission prompt makes the most dangerous option the most conspicuous.**
   `PermissionPrompt` is the only gate standing between the embedded agent and the
   database. `allow_once` took `.primary` (the brightest thing on screen),
   `allow_always` (a permanent grant) gets only the default button appearance, and
   `reject` is the weakest of them. It declares `role="alertdialog"` without
   `aria-modal` and without moving focus into itself — it promises modal semantics
   and does not pay out. And `dontAsk` / `bypassPermissions` are two options in an
   ordinary `<select>`, separated only by the `--warn` colour (pure colour coding),
   with no second confirmation.

2. **In-place second confirmation is a mis-deletion trap.** "Remove from list"
   (`Sidebar.tsx`) and "Delete session" (`ChatSessionsRail.tsx`) are both: click
   once → the button turns **in place** into "Confirm" → click again to execute.
   The mouse does not have to move a single pixel, and double-click momentum hits
   every time. Neither is undoable (the first discards the keychain credential
   along with it).

3. **A cell cannot be copied.** `body { user-select: none }`, `.grid-cell` never
   turns on `user-select: text`, the whole renderer makes zero clipboard calls, and
   `DataGrid`'s keyboard table has no `⌘C`. The one exit is a double-click opening
   `ValueModal`, and `isExpandable` demands a string over 80 characters or one
   containing a newline — **a UUID, a timestamp, a number: the user has no way
   whatsoever to get it out**. This is a database GUI's number-one operation.

### 1.3 Conflicts with existing documents (reconciled; this document is the new source of truth)

| document | its conclusion | this round | ruling |
|---|---|---|---|
| `2026-08-02-connection-list.md` §2.6 | "the driver id stays right-aligned, faint, **10px**" | 11px, with faint brightened to 4.5:1 | **Overturned**. 10px is a product of density aesthetics, not of what that row has to carry; there is a lot of white space to the right of it, and shrinking to 10px buys nothing |
| `2026-08-02-settings-panel.md` §2.2 | "'Appearance' holds only language for now", "no theme switching" | Appearance gains **interface zoom** | **Extended, not overturned**. What the original excluded was theme switching; zoom is a different thing, and it is exactly the sort of thing §2.2 called "somewhere for future items to land" |
| `2026-08-02-connection-list.md` §2.7 / `2026-08-02-chat-session-management.md` §2.6 | a destructive action is "two clicks to confirm, no modal, blur cancels" | **still two clicks, still no modal**, but the second click's landing point moves elsewhere | **Hardened, not overturned**. See §2.5 |
| `docs/PLAN.md` §10, "deliberately not done" | "real screen-reader verification of a11y should not be done on an agent's behalf" | **unchanged** | This round changes only code and unit-test assertions, and **has not claimed VoiceOver and will not**. §4.3 leaves it explicitly to a human |

The line at the top of `styles.css` — "compact density of a data tool" — does not
change. This document is not relaxing the density; it is laying a floor under it:
**11px / 4.5:1 / a 24px hit area, which is exactly TablePlus's own floor**.

### 1.4 Boundary (explicitly not done)

- **Row heights do not change.** `--row-h: 24px`, `--head-h: 26px`, `--bar-h: 30px`
  all stay. The body of the density is the row height; what changes here is the
  type floor and the colours, and the two are orthogonal.
- **No light theme.** `settings-panel.md` §2.2's conclusion carries.
- **No external-browser channel for the agent's output.** That comment in
  `Markdown.tsx` still holds; this round only settles the deceptive affordance of
  "looks like a link but cannot be clicked" (§2.7), and adds no navigation surface.
- **No real screen-reader verification.** See §4.3.
- **No CSS framework, and no design-token generator.** Every change lands on the
  existing `:root` variables.

## 2. The plan

### 2.1 The type ladder: an 11px floor for text, a 10px floor for marks

`:root` gains a set of semantic size variables, replacing the naked numbers
scattered around:

```css
--fs-sm: 11px;    /* the floor for secondary text */
--fs-md: 12px;    /* the baseline */
--fs-lg: 13px;    /* headings, emphasis */
--fs-data: 11.5px;/* cells: monospaced literals, slightly larger than --fs-sm to compensate for the visual weight of monospaced glyphs */
--fs-mark: 10px;  /* purely geometric marks only, see below */
```

The rules, written down so they can be reviewed:

- **Anything that is words is at minimum `--fs-sm` (11px).** The existing 10px
  tier all moves up, and the 9px tier disappears.
- **Purely geometric marks** (the disclosure arrow `▸`, the `✔` in a checkbox) are
  not bound by the text floor and use `--fs-mark` (10px), because their legibility
  is carried by **shape and size** rather than by type size — but they must have a
  size floor of their own (`.tree-caret` is 14px wide, `.md-check` is 11×11), and
  may carry no text that has to be made out.
- **`--fs-data` is for data values only.** Being 0.5px larger than secondary text
  is deliberate: a cell holds a monospaced literal, and at the same type size a
  monospaced glyph's strokes are denser than a proportional one's.

### 2.2 Colour: all three text steps pass, and borders split into "decoration" and "component"

| variable | old | new | on `--bg` | on `--bg-1` | on `--bg-2` |
|---|---|---|---|---|---|
| `--fg` | `#d3d8de` | unchanged | 12.40 | 11.66 | 10.74 |
| `--fg-dim` | `#8a929c` | `#a8b0ba` | 8.11 | 7.63 | 7.03 |
| `--fg-faint` | `#5a626c` | `#858d97` | 5.29 | 4.98 | **4.58** |

The three steps descend 12.4 / 7.6 / 5.0, a **clearer** hierarchy than the old
12.4 / 5.3 / 2.7, because the old last step had already fallen out of the readable
range and only two steps were actually working. The baseline is taken as
**`--fg-faint` on `--bg-2` ≥ 4.5** — `--bg-2` is the brightest background faint
lands on. (On `--bg-3` it is 4.07, but faint has no real use case on `--bg-3`;
text on `--bg-3` is always `--fg-dim` or `--fg`.)

Borders split into two responsibilities, because WCAG's requirements for them
differ to begin with:

| variable | old | new | contrast | responsibility |
|---|---|---|---|---|
| `--border` | `#2a2f36` | `#333941` | 1.53 vs `--bg` | **decorative separation**: cell grid lines, panel outlines. No 3:1 requirement — its job is grouping, not marking something interactive |
| `--border-strong` | `#3a414a` | `#666f79` | **3.02–3.48** (all three tiers pass) | **component boundary**: inputs, buttons, selects. This is what WCAG 1.4.11 applies to, and 3:1 is mandatory |

(`--border-strong`'s first version took `#606973`, which measures 2.9967 on
`--bg-1` — **the test went red**, and neither the eye nor rounding to two decimal
places can see it. This is precisely why the test in §4.1 exists, and it is the
first thing that test caught on its first day.)

The rest of the non-text:

- **The self-drawn scrollbar**: `.grid-vsb-thumb` goes from `--fg-faint` @ 0.4
  (1.46) to solid `--border-strong` (3.00), with `--fg-faint` (5.29) on hover and
  while dragging.
- **Row selection**: the accent background goes 18% → 24%, and `.grid-rownum`
  gains a 2px solid accent left bar — **a shape cue, not only a colour one**, and
  the only part of the selected state a colour-vision-impaired user can read.
- **Zebra striping**: `#191c20` → `#1e2228` (1.04 → 1.11). Still extremely faint,
  but no longer "drawn and yet not drawn".

#### 2.2.1 Extension (2026-08-02, evening): `opacity` falls through the floor too, and the test never sees it

The table above compares **pairs of tokens in `:root`**. That is exactly its blind
spot: a run of text's actual contrast can also be pulled down by `opacity`, and
`opacity` neither changes a token nor appears in any `color:` declaration. **A
floor holds only where the test happens to be looking** — and this is the third
time that same sentence has come true:

| # | escape route | consequence |
|---|---|---|
| 1 | written as a literal instead of a token | `#7a3f3f` survived at 1.91:1 (see §2.2 and the control spec §1.2) |
| 2 | written on `background` (the regex banning literals only covers `border`/`outline`) | a batch of background literals is still on the books |
| 3 | **using `opacity` rather than changing the colour** | this section |

**The compositing model has to be computed correctly.** `opacity` applies to the
whole subtree: the element's background **and** its text are composited onto the
surface below together, so both shift **at the same time** — it is not "text
sitting on an unchanged background".

$$\text{effective foreground} = \alpha F + (1-\alpha) B_{\text{below}} \qquad
\text{effective background} = \alpha S + (1-\alpha) B_{\text{below}}$$

($S$ is the element's own background; for an element with no background
$S = B_{\text{below}}$ and both formulas degenerate to the simple form.) In this
repository the two algorithms differ by 0.01, because `--bg-1` and `--bg-2` are
close to begin with; but 0.01 is a coincidence of this palette, not a licence to
simplify the model.

**Measured and dispositioned** (all 10 `opacity` sites in the repository,
classified one by one):

| site | α | measured | disposition |
|---|---|---|---|
| `.chat-chip.receipt` → `.chat-chip-kind` (`--accent`) | 0.75 | **3.72** | **mute it with a token instead**, drop the opacity |
| `ViewError`'s driverCode / position span | 0.7 | **3.52** | switch to the `--fg-dim` class (7.48) |
| `.panel.drag-source` → `--fg-dim` | 0.55 | **3.23** | α → **0.75** (`--fg` 7.10 / `--fg-dim` 4.87) |
| `button:disabled` / `.btn:disabled` | 0.45 | 3.32 | **exempt**: WCAG 1.4.3 excludes disabled controls in so many words |
| `.conn-key` | 0.85 | — | exempt: the content is 🔑, not text |
| `.col-resizer.active` | 0.7 | — | exempt: a 7px colour bar, not text |
| `@keyframes pulse` / `chat-pulse` | 0.25→1 | — | exempt: what moves is a dot (geometry), and it is an animation rather than a resting state |

Why the first three are fixed the way they are:

- **Muting the chip**: `--accent` does not clear 4.5 until α = 0.88, and the muting
  effect at 0.88 is all but invisible to the eye — that is not "tuning a
  parameter", it is the technique itself not working. The receipt chip instead
  says "sent" with a darker token at **full opacity**, which makes the colour
  auditable again.
- **ViewError**: those two runs are secondary information inside an error box, and
  `--fg-dim` is already the token for "secondary". Two inline `style`s go along
  with them.
- **drag-source**: 0.55 was never argued for; only the intent, "dimmed", was.
  0.75 keeps the intent and clears AA, at zero cost.

**The real fix is the assertion, not those three edits.**
`theme-contrast.test.ts` gains an **enumeration table**: every `opacity` must be
registered in it (adding one without registering it goes red), each one registered
as non-exempt has its composited contrast computed by the formula above and
asserted ≥ 4.5, and each one registered as exempt **must carry a written-out
reason** — the same shape as §2.3's requirement for hit-area exemptions: **going
below the floor must be a sentence somebody wrote, not an accidental result of a
calculation.**

### 2.3 Hit areas: `--hit-min: 24px`

A new variable, and everything adjusted to it:

| element | old | new |
|---|---|---|
| `button` | padding `2px 8px` (23.4 computed) | padding `3px 9px` **+ `min-height: var(--hit-min)`** |
| `.tab-close` | 16×16 | **20×20** |
| `.chat-chip-x` | ~14×14 | **min 18×18** |
| `.tree-action` | 16 tall | **20** tall |
| `.tree-node` | 22 tall | **24** tall (aligned with `--row-h`, which also makes room for the 20px button) |
| `.statusbar` | 22 tall + `overflow: hidden` | **26** tall |

**Why `min-height` rather than padding alone**: padding cannot do it, and in
principle cannot — a button inherits its type size, so one and the same rule
yields 25.4px in 12px body text and only **23.9px** in the 11px status bar. That
is not derived, it is measured off the build output with CDP (§4.2 item 8).
`min-height` is what makes the floor independent of context.

Four exemptions, all of them inline controls inside a compact bar, each with an
explicit height of its own: `.tab-close` (20, inside a 30px tab bar),
`.tree-action` (20, inside a 24px row), `.chat-chip-x` (18, inside a 20px chip),
and `.md-copy` (inside the title bar of a code block with 1px of padding). Each
writes `min-height: 0` in its own rule with the reason noted — **going below the
floor must be a sentence somebody wrote, not an accidental result of a
calculation**.

> **Extension (2026-08-02, same day)**: these four "exemptions" have been made
> official by [`2026-08-02-control-spec.md`](2026-08-02-control-spec.md) §2.4 as a
> **size step**, `size="sm"` (20px + `--fs-sm`). Writing `min-height: 0` out four
> times is itself another form of the thing this note is trying to prevent — the
> reason is written down, but it is written down four times, and the fifth place
> that needs a small button still has no choice but to invent it again.
> `.chat-chip-x`'s 18px rises to 20px along with it and joins the step.
>
> A sentence added once the migration was done: all four **also** wrote
> `font-size: var(--fs-sm)` next to the height, so the step initially collected
> only half of it. The type size later joined the step too. The same lesson, the
> same batch of rules, and it took hours to see whole —
> **the signal "one thing is being restated four times" was recognised only halfway
> the first time.**
>
> Only `.tree-action` is still hand-written, because `TreeView.tsx` has somebody
> else's uncommitted changes and was not migrated. The floor, and "going below the
> floor must be explicit", are unchanged.

`.statusbar` growing 4px is the only layout dimension this round changes, and it
is forced: a 22px container was clipping a 23.4px button, so changing the button
means changing the container. `.toasts { bottom }` moves from 32px to 36px with it.

`.col-resizer` (7px) and `.divider` (5px) do not move: both give hover feedback and
are dragged rather than clicked, and 7px is the same size VS Code uses.

### 2.4 Interface zoom: `webContents.setZoomFactor`, not a type-size variable

**Whole-page zoom was chosen**, for the reasons in §3.1. It lands in three places:

1. **main**: apply the persisted `uiZoom` after `createWindow`; a new custom
   application menu, whose `View` category offers "Zoom In / Zoom Out / Actual
   Size" with the accelerators `⌘+` / `⌘-` / `⌘0`. **The production build's menu
   has no Reload, Force Reload or Toggle DevTools** (the dev build keeps them —
   those are for the developer). The `Edit` category is kept whole: `⌘C` / `⌘V`'s
   system-level bindings have to be there.
2. **Persistence**: `PeekSettings` gains `uiZoom?: number`, reusing the existing
   `settings.read` / `settings.write` commands, **adding no command**. This matches
   the shape of `settings-panel.md` §2.5: they operate on the file and on the shape
   of this installation, not on the Workspace.
3. **renderer**: an explicit step selector in the "Appearance" category (80% / 90%
   / 100% / 110% / 125% / 150%), alongside language.

The zoom range is clamped to `[0.8, 1.5]`: below 0.8 the 11px floor shrinks back to
8.8px, which is the very thing this document is trying to eliminate; above 1.5, at
the 900px `minWidth`, the sidebar and the right column get squeezed out.

**Its relationship with `vscroll` (which has to be written down)**: `vscroll.ts`'s
geometry depends on `devicePixelRatio`, and `setZoomFactor` changes it. That chain
is connected and needs no new code — zooming also changes `.grid`'s `clientHeight`,
which fires `DataGrid`'s `ResizeObserver`, and `setGeometry` re-reads
`window.devicePixelRatio` inside the same call. §4.1 has a test pinning that order.

### 2.5 Destructive actions: steer the second click towards the safe side

The original design's two clicks are right (so is not raising a modal). What is
wrong is that **both clicks land on the same pixel**.

The fix is not a timeout, it is a displacement — and it makes **the original
position the safe action**:

```
before armed:  [ Remove from list ]
after armed:   [ Cancel ] [ Confirm removal ]
                ↑ where "Remove from list" used to be
```

So the second click thrown by double-click momentum lands on "Cancel". This is
better than a 300ms cooldown, because a cooldown only makes the mistake slower,
whereas a displacement steers the mistake **into the harmless one**. `onBlur`
cancelling stays.

The same change in two places: `Sidebar.tsx`'s "Remove from list" and
`ChatSessionsRail.tsx`'s "Delete".

> **One implementation detail here is overturned (2026-08-02, same day)**: the
> `.confirm-danger` class this section created for the confirm button has been
> absorbed by [`2026-08-02-control-spec.md`](2026-08-02-control-spec.md) §2.3 into
> `<Button variant="danger">`. When it was written, `.chat-perm-reject` already
> existed with a **byte-identical** definition — I did not find it, because at the
> time there was nowhere to "find" anything. That is the direct cause of that
> change; see the control spec §1.3. The design conclusion about the displaced
> confirmation is unchanged.

### 2.6 The permission prompt: equal weight, no nudging; honest ARIA

Four changes:

1. **`allow_once` and `reject_once` carry equal visual weight**, and neither is
   `.primary`. Reject is *not* promoted to the primary button: that manufactures
   confirmation fatigue on the normal path and eventually trains the muscle memory
   of "click the second one without thinking", which is more dangerous still. Equal
   weight is what Chrome's permission bubbles and macOS's system dialogs do.
2. **`allow_always` is explicitly demoted**: a `--warn` border plus a line stating
   its scope (within this session, this tool will not be asked about again). It is
   the only one of the four options that changes **future** behaviour, and that has
   to be visible.
3. **The ARIA tells the truth**: `role="alertdialog"` goes, replaced by
   `role="group"` + `aria-live="assertive"` + `aria-label`. It was never modal — the
   user needs to scroll back and read that tool call before deciding, which is the
   design intent (the original file's comment reads "modal in attention, not in the
   DOM"). Declaring `alertdialog` without implementing a focus trap is worse than
   not declaring it. Focus instead **moves to the panel container**
   (`tabIndex={-1}`), so the buttons are Tab's next stop and no button is focused in
   advance — **Return-key momentum cannot grant anything**.
4. **The dangerous modes go through a confirmation**: switching to `dontAsk` /
   `bypassPermissions` first shows an inline confirmation in the panel (reusing
   `.chat-permission`'s shape), and only sends `chat.setMode` once confirmed. The
   option text is also prefixed with `⚠`, so "this step is different" does not rest
   on colour alone.

### 2.7 Copying, focus, motion, and modal consistency

- **Copying a cell**: `DataGrid`'s keyboard table gains `⌘C` / `Ctrl+C` — with a row
  selection it copies the selected rows (TSV, headers included), otherwise it copies
  the current cell's complete value (`fullValueText`, the same one `ValueModal`
  shows). The context menu offers the two copy items in step. `ContextMenu` keeps to
  its own job of "add to the conversation", and the copy items are injected by
  `DataGrid` as `extraItems` — the menu does not need to know the result cache
  exists.
- **The grid's focus ring**: `.grid-wrap` has `tabIndex={0}` but its focus ring is
  wiped out by `outline: none`, and `keyboard-nav.css`'s three rules do not cover it.
  Add `:focus-visible`. Likewise for `.ctx-menu`.
- **`prefers-reduced-motion`**: four `infinite` animations (the connection pulse, the
  tree spinner, the chat status dot, the tool-call spinner) plus the drag-and-drop
  highlight's `transition`, all degraded to static in a single media query. **State
  may not be carried by animation alone**: with its animation stopped,
  `.dot.connecting` is still a solid `--warn` dot, still distinguishable from idle's
  hollow one and ready's green.
- **Modal consistency**: a new `hooks/useModalDialog.ts` — focus trap, focus returned
  to the triggering element on close, and Esc consumed only by the one on **top of
  the stack** (a module-level stack, with `stopPropagation` in the capture phase).
  Used by `ConnectDialog` / `ValueModal` / `SettingsDialog` / `ConsentDialog`. At the
  same time `ConnectDialog`'s overlay click **no longer closes**: it is a form with a
  host, a port and a password filled in, and discarding all of that to a stray click
  on the overlay is an unacceptable price; `ValueModal` (read-only) keeps
  click-overlay-to-close.
- **Toasts can be read aloud**: `error` / `warn` use `role="alert"`, `info` uses
  `role="status"`. As things stand a screen reader hears nothing at all of an error
  notification — `App`'s LiveRegion announces only layout changes.
- **`.md-link` stops pretending to be a link**: `cursor: help` becomes
  `cursor: copy`, and clicking copies the URL. Affordance and behaviour agree from
  then on, and no external navigation surface is added.

### 2.8 Files involved

| file | what changes |
|---|---|
| `renderer/styles.css` | the `:root` type-size and hit-area variables, three text colours, two border tiers, type sizes raised, hit areas, focus rings, `prefers-reduced-motion`, the scrollbar and the selected state |
| `renderer/components/chat/chat.css` | the same on the chat side (the 10px tier, the permission panel, chip hit areas) |
| `renderer/components/context-actions/context-actions.css` | the 10px/11px tiers and hit areas |
| `renderer/keyboard-nav.css` | `.grid-wrap` / `.ctx-menu` focus rings |
| `packages/core/src/commands.ts` | new `UI_ZOOM_*`, `clampUiZoom`, `stepUiZoom`; `settings.write` accepts `uiZoom`, and both result types carry it |
| `renderer/components/settings/AppearanceSection.tsx` | add the zoom selector (over `settings.read` / `settings.write`, **no new store** — zoom is applied by main, it is not a renderer-local preference) |
| `renderer/hooks/modalStack.ts` | new: the pure logic of who owns Esc and how Tab wraps |
| `renderer/hooks/useModalDialog.ts` | new: focus trap + focus return + hooking into that stack |
| `renderer/components/ConfirmPair.tsx` | new: the two-stage confirmation for destructive actions, shared by both sites |
| `renderer/components/gridCopy.ts` | new: the copy serialisation for cells and rows |
| `renderer/components/chat/permissionOptions.ts` | new: the ordering of permission options, their button classes, and the dangerous-mode test (pure functions, directly assertable) |
| `renderer/components/{ConnectDialog,ValueModal}.tsx` | wire up `useModalDialog`, add `role`/`aria-modal` |
| `renderer/components/settings/SettingsDialog.tsx`, `context-actions/ConsentDialog.tsx` | wire up `useModalDialog` |
| `renderer/components/chat/PermissionPrompt.tsx` | §2.6 items 1–3 |
| `renderer/components/chat/ChatView.tsx` | §2.6 item 4 |
| `renderer/components/DataGrid.tsx` | `⌘C`, injecting the copy menu items |
| `renderer/components/context-actions/ContextMenu.tsx` | `extraItems` |
| `renderer/components/{Sidebar,chat/ChatSessionsRail}.tsx` | §2.5 |
| `renderer/components/Toasts.tsx` | `role` |
| `renderer/components/chat/Markdown.tsx` | click a link to copy |
| `main/menu.ts` | new: the application menu |
| `main/index.ts` | assemble the menu, apply `uiZoom` at startup, re-apply it on every `did-finish-load` |
| `main/config/settings.ts`, `config/handlers.ts` | the `uiZoom` field and its read/write; injecting `applyZoom` |
| `renderer/components/{Toasts,chat/Markdown,chat/ChatSessionsRail,Sidebar}.tsx` | `role`, link copying, both confirmations switched to `ConfirmPair` |
| `i18n/messages/{en,zh-CN}/*` | new keys for zoom, copying, the permission explanations, the dangerous-mode confirmation, and confirm/cancel |

Tests: `renderer/__tests__/{theme-contrast,type-scale}.test.ts`,
`renderer/hooks/__tests__/modal-stack.test.ts` and
`renderer/components/__tests__/grid-copy.test.ts` are new;
`main/bus/__tests__/settings.test.ts` and
`renderer/components/chat/__tests__/chat.test.ts` are extended.

## 3. Trade-offs

### 3.1 Whole-page zoom, rather than type-size variables

**Chosen** `webContents.setZoomFactor`.
**Not chosen** making the type sizes adjustable variables (`--fs-*` times a factor).

Type-size variables enlarge only the type — not the row height, not the spacing,
not the hit areas. And 11px type against a 24px row is the result of this design
being **in proportion**; take the type alone up to 14px with the row height
unchanged and the sense of density collapses immediately, while the 16px close
button is still 16px. Somebody whose eyes need a bigger interface does not want
"bigger type crammed into the same cells", they want **the whole thing bigger**.

Whole-page zoom also has a property too cheap to pass up: it is a zero-line change
to 1,766 lines of CSS. The type-variable approach means replacing dozens of naked
numbers with `calc()` one at a time, every one of them an opportunity to get it
wrong, in exchange for a worse result.

The cost: zoom is window-level, and cannot enlarge the table alone. Accepted —
nobody has asked for that.

### 3.2 Why `--fg-faint` is not simply folded into `--fg-dim`

It saves a variable and loses a whole step of hierarchy. A sidebar row's `label`
(`--fg`) / secondary line (faint) / driver id (faint) already carries three
densities of information, and merging would make the driver id as loud as the
connection name. The right fix is to **repair** the broken step rather than delete
it — and once repaired, the three steps' spacing (12.4 / 7.6 / 5.0) is more even
than it was.

### 3.3 Why destructive actions get no confirmation dialog

`connection-list.md` §2.7 and `chat-session-management.md` §2.6 both ruled that
these two actions do not merit a modal. That ruling is not wrong; what is wrong is
**where the second click lands**. Displacement is the zero-cost fix: no extra
mental interruption, no new modal layer, just momentum landing on a harmless
button.

"A 300ms cooldown after arming" was not chosen either: a cooldown is useless
against a **deliberate** fast double-click (the second click usually comes after
300ms), and it only makes everybody slower rather than making the mistake safe.

### 3.4 Why the permission prompt does not promote "reject" to the primary button

Nudging the user to reject and nudging them to agree are the same mistake, only in
opposite directions. The real consequence is confirmation fatigue: if reject is the
biggest and brightest one, and 90% of calls ought to be agreed to, the user will
train the habit of "skip reading, click the second one" — and then the one call
that really is dangerous gets clicked away just the same.

Equal weight plus demoting `allow_always` on its own spends the visual budget on
**the only option that changes future behaviour**, rather than on scoring the
answer to this one occasion.

### 3.5 Why `role="alertdialog"` is removed rather than a focus trap added

Because a focus trap is the wrong thing here. This panel is deliberately not modal
— it sits above the composer instead of covering the window precisely so the user
can scroll back and read that tool call before deciding (the original comment says
so). Making it genuinely modal would destroy that design intent; keeping the fake
`alertdialog` is lying to the screen reader. The third path is to tell the truth:
`role="group"` + an `assertive` live region, with focus moved to the container
rather than locked inside it.

### 3.6 Why the copy items are injected by DataGrid rather than going into `descriptors.ts`

Every item in `contextActionsFor` `build()`s a `ChatAttachment`; the whole module is
built around the single thing "add to the conversation" (even its test is called
`descriptors.test.ts`). Copying produces no attachment, and stuffing it in means
either opening a discriminated union on `ContextAction` or giving `build()`
returning `null` a second meaning. An optional `extraItems` prop separates "the
menu" from "what is in the menu", and `ContextMenu` therefore does not need to know
`resultCache` exists.

## 4. Verification

### 4.1 Automated (`pnpm -r test` + `pnpm typecheck`)

New:

- `renderer/__tests__/theme-contrast.test.ts` — **turns this document's tables into
  assertions**: parse `styles.css`'s `:root`, compute the WCAG contrast for every
  pair in §2.2 and assert the floor (4.5 for text, 3.0 for `--border-strong`). The
  point of this test is that **the floor cannot quietly drift back**.
- `renderer/__tests__/type-scale.test.ts` — scan every `font-size` across the three
  CSS files and assert that no value is below 10px, and that values below 11px
  appear only on whitelisted selectors (`--fs-mark`'s geometric marks).
- `renderer/state/__tests__/ui-scale.test.ts` — the steps clamp to `[0.8, 1.5]`, an
  illegal value falls back to 1, and localStorage throwing does not affect
  usability.
- `main/config/__tests__/settings.test.ts` (changed) — `uiZoom`'s read/write round
  trip and its clamping.
- `renderer/components/chat/__tests__/chat.test.ts` (changed) — the permission
  options' button-class mapping (`allow_once` is no longer `primary`,
  `allow_always` carries the warn class); the dangerous-mode confirmation state
  machine.
- `renderer/components/__tests__/grid-copy.test.ts` — TSV serialisation: headers
  included, tabs and newlines escaped, and the cell path and the row path each
  correct.
- `renderer/hooks/__tests__/modal-stack.test.ts` — Esc consumed only by the top of
  the stack; focus returned once the stack empties.

### 4.2 Manual (to run through once the changes are in)

Item 8 is the only one of this round that has **already been run**: start the build
output, isolate `PEEK_CONFIG_DIR` and the MCP port, attach
`--remote-debugging-port`, and read the real computed style back with
`Runtime.evaluate`. It overturned one of this document's numbers on the spot (see
§2.3's `min-height`), which is exactly the value of "read the rendered result
rather than the stylesheet". The rest need a human in front of the window, and are
left to a human.

1. Look screen by screen at the sidebar, the table and the chat panel, confirming
   no **text** is smaller than 11px.
2. Select a UUID cell in the table → `⌘C` → paste out the complete value; select 3
   rows → `⌘C` → paste out TSV with headers.
3. Click "Remove from list" once → the confirm button appears on the **right**, with
   "Cancel" in the original position; a fast double-click does not delete.
4. Press Return while the permission prompt is up: **nothing should happen**. One
   Tab lands on the first button.
5. `⌘+` / `⌘-` / `⌘0` to zoom; at 150% scroll through the million-row table and
   confirm the rows do not misalign (§2.4's dpr chain); after a restart the zoom is
   still there.
6. The production build's menu has no Reload and no DevTools; `⌘C` / `⌘V` still
   work.
7. Turn on macOS "Accessibility → Display → Reduce motion" and confirm that the
   connecting dot, the tree spinner and the tool-call spinner all stop, and that the
   states are still distinguishable.
8. **(already run)** Start the build output and read the computed style: `:root`'s
   six variables hold the new values; the smallest **text** on the page is 11px (not
   one 10px anywhere); no button is smaller than 24×18; the status bar is 26px with
   its button at 24px — that is, no longer clipped by `overflow: hidden`.

### 4.3 Verification not done (left to a human)

**A real screen reader (VoiceOver) has not been run, and is not going to be this
round.** `PLAN.md` §10 already assigns this to a human, and the reason is unchanged:
an agent cannot judge whether a passage sounds usable when read aloud. The ARIA
added this round (the toasts' `role="alert"`, the permission panel's `assertive`
live region) has DOM assertions only, which **does not amount to "verified"**. This
belongs in `PLAN.md` §11.2's technical debt.
