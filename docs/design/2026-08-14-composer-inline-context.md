# Attachments merged into the composer: what a chip is called, and `@` mentions

## 1. What this fixes

### Where things stand

The bottom of the chat panel is currently **three stacked** independent bars:

```
┌ MessageList ────────────────────────────┐
├ AttachmentBar ──────────────────────────┤   ← the "上下文" label + chips + "+ 添加上下文"
├ Composer ───────────────────────────────┤   ← textarea
│  ⏎ 发送 · ⇧⏎ 换行              [ 发送 ] │   ← the action row
└─────────────────────────────────────────┘
```

`AttachmentBar` (`components/chat/AttachmentBar.tsx`) is permanent: with no attachments it still
renders a `min-h-head` row reading `上下文　暂无附件`. An attachment itself is a chip, and each chip
is made of two segments — a kind segment (`chat.attach.kind.*`, e.g. `行`, `结果集`) and a label
segment (`ChatAttachment.label`).

### Problem A: a chip's label is currently an imperative sentence

In the screenshot, that chip looks like this:

```
上下文   ( 行  把 16 行加入对话  × )
```

`行` is the kind segment, and `把 16 行加入对话` is the label segment. This is not a layout problem,
it is a **semantic** one: what sits in the label position is a line of **action copy**, while a chip
is a **noun** — it answers "what will this message carry", not "what happens if I click me".

The root cause is in two places, written identically in both:

- `context-actions/SelectionActionBar.tsx:52,86` — the floating bar first computes the button copy
  `label = t('context.float.add', {count})`, and then passes **the same string** into
  `rowsAttachment(viewId, resultId, indexes, label)` as the attachment's name;
- `context-actions/descriptors.ts:167-227` — every item in the context menu is
  `const label = t('context.attach.xxx'); build: () => xxxAttachment(..., label)`. So rows added from
  the menu produce a chip reading `行　加入选中的 16 行`.

One string serving two positions, whose grammatical requirements are exactly opposite, and the result
is a chip that permanently carries a superfluous verb and repeats the noun in the kind segment beside
it. Stack the chip's `max-w-65` truncation on top, and what survives after a long sentence has its
tail cut off is often precisely **the segment with the least information** (`把 16 行加入…`), while
the thing that actually needs recognising — which table, which view — never appeared at all.

### Problem B: attachments do not look like "part of this message"

The attachment bar is a box of its own, with its own top border, level with the composer and beside
it. Yet the thing it describes (`ChatViewState.attachments`) is meaningful only to the **next
message** — once sent, they become receipts inside a `MessageItem` and the staging area empties. The
visual hierarchy and the lifecycle do not match.

There is also only one road to adding context: the one button at the bottom right. Someone in the
middle of typing has to lift a hand and go click it, with no keyboard entry point at all — and this
is the second most common thing done in a chat.

### This change's boundary

Three things get done:

1. **Merge the attachment area into the composer**, making one box (called the composer box below),
   which takes no height when empty;
2. **Give chips their own copy**, with the label answering only "what is this", split cleanly from
   the action copy;
3. **Add `@` mentions**: typing `@` in the composer raises a candidate list, and picking one makes a
   chip.

**Not done**:

- The textarea is not replaced with rich text / contenteditable. `@orders` stays in the body, but it
  is **ordinary text**, not a clickable chip, and not two-way bound to the chip; the reasoning is in
  §3.1;
- The `ChatAttachmentSpec` contract does not change, and neither does resolve/serialize on the main
  side. This change is purely in the renderer plus a batch of copy keys;
- No "`@` searches the whole database's table names". Candidates come only from what is already open
  in the current workspace; the reasoning is in §3.4;
- `SelectionActionBar`'s existence and gestures are untouched (it can reach the grid's selection and
  `@` cannot, see §3.5); only the label it hands over changes;
- `ConsentDialog`'s timing and copy do not change. The first attachment added by `@` goes through the
  disclosure gate just the same.

## 2. The plan

### 2.1 One box

`AttachmentBar` is no longer a direct child of `ChatView`; it is swallowed by `Composer` and becomes
its first row:

```
┌ composer box ───────────────────────────┐
│ (行 orders · 16 行 ×) (表结构 public.o…) │  ← the chips row; not rendered at all with no attachments
│ 问问这些数据…                            │  ← textarea
│ ⏎ 发送 · ⇧⏎ 换行 · @ 添加上下文  [发送] │  ← the action row
└─────────────────────────────────────────┘
```

Specifically:

- **The `上下文` prefix label is deleted.** A chip carries its own kind segment, which already says
  what each one is; a label that is meaningful only when there are attachments yet occupies space
  permanently is itself one of the reasons this bar has too much presence.
- **The empty state is not rendered.** The sentence `暂无附件` does not need to hang there all the
  time — the thing it wants to say (you can attach things) is carried instead by the hint on the
  action row: `⏎ 发送 · ⇧⏎ 换行 · @ 添加上下文`. So with no attachments the composer is one row
  shorter, and the height goes to the transcript.
- **The `+ 添加上下文` button is kept**, as the mouse path, moved to the left of the action row; a
  click is equivalent to inserting `@` at the end of the draft and raising the candidate list (i.e.
  it takes the same code path, leaving no second set of logic).
- Borders: one `border-t` for the whole composer box, with no divider between the chips row and the
  textarea; the chips row gets a `pb-tight` of breathing room only when it exists.

On the component split, `AttachmentBar` breaks into two: `AttachmentStrip` (rendering the chips, with
no border and no label, used by Composer) and `AttachMenu` (the candidate list, shared by `@` and
`+`). `chipClasses` stays where it is — `MessageItem`'s receipt still imports it from there, and the
reasoning behind that dependency direction has not changed.

### 2.2 A chip's name: the label is a noun phrase

A new group of **`context.label.*`** copy, parallel to the existing `context.attach.*` (menu items)
and `context.float.*` (floating bar buttons). The three face three grammatical positions, and from
now on they do not borrow from each other:

| kind | chip shows | where the name comes from |
|---|---|---|
| rows | `行　orders · 16 行` | `context.label.rows` = `{source} · {count} 行` |
| result | `结果集　orders · 前 200 行` | `context.label.result` = `{source} · 前 {count} 行` |
| cell | `单元格　orders.email[42]` | `context.label.cell` = `{source}.{column}[{row}]` |
| query | `查询　查询 1 · SQL` | `context.label.query` = `{source} · SQL` |
| schema | `表结构　public.orders` | `collectionRefLabel(ref)`, not entering the catalogue |
| workspace | `工作区　当前工作区` | reuses `chat.attach.option.workspace` |

The last two rows deliberately have no key of their own: `public.orders` is already this chip's best
name in any language, and giving it a `'{name}'` translation entry is just wrapping an identifier in
a shell that does nothing; the workspace sentence has already been written once in the candidate
table, and a second copy would only fork.

`{source}` is always `viewTitleOf(t, view)` — a view's title is already the single way of saying
"where this data came from" (the tab title and the drag label both use it), and having a chip mint
another one is the first day of them forking.

One rule is nailed down: **a label does not contain a word the kind segment has already said.** The
second `行` in `行　orders · 16 行` is a measure word, not a category, and may stay; the verb in
`行　加入选中的 16 行` may not.

Every builder in `descriptors.ts` therefore gets two strings — what the menu shows (`label`) and what
the chip is called (`chipLabel`). The `ContextAction` interface gains exactly one field, and
`build()` uses the latter. The same for `SelectionActionBar`: the button still reads
`把 16 行加入对话`, and the name it hands over is `orders · 16 行`.

> This also fixes an inconspicuous dislocation along the way: the `context.added` toast currently
> reads out `已把 把 16 行加入对话 加入对话`. It uses the same `attachment.label`.

### 2.3 What `@` means: the name stays in the body, and the chip is the data

On pressing `@`:

1. an `@` character is **actually inserted** into the textarea (the user has not been hijacked, and
   after Esc it is just an ordinary at);
2. the candidate list appears, anchored above the composer box;
3. characters typed after the `@` are the **filter term**, filtering candidates keystroke by
   keystroke;
4. picking an item: the `@` plus filter term is replaced by `@<mention name>` followed by one space,
   with the caret landing after it, and at the same time the attachment is staged and the chips row
   gains one.

So a sentence reads as a whole:

```
(结果集 orders · 前 200 行 ×)
> @orders 这张表为什么有这么多空的 email？
```

**The mention name** is given by the candidate itself, the rule being "take the segment that looks
most like an identifier, and remove the whitespace": schema and result use `CollectionRef`'s
identifier (`public.orders`), query uses the view title with the spaces taken out (`查询 1` →
`查询1`), and workspace uses `workspace`. Carrying no spaces is a hard requirement — a mention name
with a space in the body breaks halfway through being read, and a person cannot tell where the name
ends and the sentence begins.

Two same-named tables (on different connections) produce the same mention name. **No deduplicating
suffix is added**: those few characters in the body are for a person to read, and which data they
point at is decided by the chip, which reads `{source} · …` and therefore already carries the view
name.

The trigger condition: the `@` is preceded by the start of a line or a whitespace character. That way
`user@example.com` and `a@b` raise nothing.

### 2.3.1 A mention is **atomic**: delete those few characters and the attachment is gone

This is the easiest thing in this design to get wrong, so the conclusion first: **the
`@public.orders` in the body and its corresponding chip are two display positions of the same thing,
and deleting either takes the other with it.**

Three rules:

1. **Atomic deletion.** With the caret resting at the end of a mention (or after the space following
   it), one backspace deletes the whole `@public.orders`, not one character. The intermediate state —
   `@public.order` — does not exist at all, so there is no need to answer "does a half-deleted one
   still count as a reference". The Delete key at the head of a mention works the same way.
2. **Reconciliation.** After the draft changes, as soon as some mention added by `@` **cannot be
   found in the draft even once** (deleted wholesale, cut, select-all-and-rewrite, undone — by any
   path), fire one `chat.detach` for it, and the chip disappears.
3. **The reverse also holds.** Clicking the × on a chip deletes those characters from the draft too.

The direction is **one way**: typing `@orders` by hand attaches nothing out of thin air. Only a
mention that was picked from the candidate list is tracked, and the tracking table lives in
`Composer` (`identity → mention name`). This rule is the antidote to §3.1's worry about "guessing
which data the user meant" — peek never guesses, it only remembers what the user explicitly picked.

The same mention name appearing twice in the draft (copy-paste), with one of them deleted, does not
detach: reconciliation asks "is it still there", not "how many".

**This approach was learnt from others.** The rich-text camp (Cursor, ChatGPT, Notion, Linear, all
with ProseMirror / Lexical / Tiptap mention plugins underneath) makes a mention an **atomic node**:
individual characters inside it cannot be edited, one backspace makes the whole thing disappear, and
the reference disappears with it. The plain-text camp (Claude Code's CLI, GitHub's comment box)
simply has no separate attachment state at all — `@x` is text, parsed on send, and deleting it
naturally removes it. The two camps do it differently, but **not one of them lets the text and the
reference live separate lives.** peek needs chips (16 rows selected in a grid cannot be expressed by
one word, and can only be a chip), so it takes the first camp's road, using the three rules above to
produce atomic-node behaviour inside a textarea.

**The hint has to be there all the time.** This is the key to whether `@` is discoverable at all, and
it is in three places:

- ordinarily — the action row's hint reads `⏎ 发送 · ⇧⏎ 换行 · @ 添加上下文`, which is the only
  explanation there is when no attachments exist (it replaces the old `暂无附件` sentence);
- just after `@` is typed, with no filter term yet — the candidate list expands right away, with a
  line of grey text at the top: `输入名字筛选，↑↓ 选择，⏎ 确认`;
- filtered down to no matches — the candidate list **does not close**, and shows
  `没有匹配的内容。可以打开一张表或跑一条查询，再回来 @ 它`. Closing it would make people think `@`
  is broken, when the real answer here is "you have not opened that thing yet".

Keyboard (all inside the textarea's `onKeyDown`, and **all of it yielding to the IME** — nothing is
intercepted when `isComposing` or `keyCode === 229`, which is a rule `Composer` already has, since
under Chinese input the Enter that picks a character must not be swallowed just because the candidate
list is open):

| key | behaviour |
|---|---|
| `↑` `↓` | move the highlight; not intercepted when the candidate list is closed |
| `⏎` / `Tab` | pick the highlighted item. **Enter does not send the message while the candidate list is open** |
| `Esc` | close the candidate list, leaving the `@` and the filter term in the draft as they are |
| backspace deleting the `@` | close the candidate list |
| space | close if there is currently no match (the case of an `@` in a sentence that is not a mention) |

### 2.4 Where the candidates come from

Reuse `attachCandidates(views, labels)` from `chat/attachments.ts`, which already derives three kinds
from the Workspace mirror: the current workspace, the **result set** of every view that has results,
and the **SQL** of every query view.

This change adds one kind: **the schema of the collection a view is browsing**. `collectionRefOf(view)`
in `context-actions/descriptors.ts` is already the answer to that question (table / vector / package
views each have their own `CollectionRef`), so lifting it out for `attachCandidates` to use is enough
— no new decision, just letting the chat side ask the same function. This kind is worth adding:
what `@orders` wants is often the **structure** rather than those 200 rows.

Rows and cells can still only come from the grid (§3.5).

Ordering: the active view's candidates first, the workspace last. Filtering: case-insensitive
substring matching on the label and hint, with no fuzzy matching — a table name is an identifier,
substring is already enough, and fuzzy matching turns things like `orders` ranking below
`order_items` into a phenomenon needing an explanation.

A candidate that has already been staged **stays in the list, marked as added and unselectable**,
rather than disappearing from it: disappearing makes people think they misread. Judging "the same
attachment" relies on `attachmentIdentity()` — `AttachmentId` cannot be used, since that is freshly
minted by main on each stage, and adding the same result twice would give two ids and two identical
chips.

At `MAX_CHAT_ATTACHMENTS` (16), a note appears at the top of the candidate list and every item is
unselectable. That cap is currently the main side's schema `.max(16)`, and hitting it presents as a
failed Command plus a toast — saying it in advance in the candidate list is cheaper.

### 2.5 The data flow does not change

`@` picks an item → `stageableAttachment(spec, chipLabel)` → `useContextActions().add(...)` → the
disclosure gate → `ContextActionPort.attach` → the `chat.attach` Command → a Workspace patch →
`view.attachments` repaints the chips.

The renderer still **keeps no local copy**. That is the original wording of the comment at the top of
`AttachmentBar`, and `@` gets no exception from it: the candidate list is computed by pure functions,
and after picking, the road taken is exactly the same as the menu's.

## 3. Trade-offs

### 3.1 A mention is ordinary text, but it is bound to the chip

Four approaches were worked through:

1. **Leave nothing behind** — after picking, the whole `@ord` disappears and only the chip is left.
   The cleanest to implement, but a sentence like "why is this table so slow" loses its subject, and
   reading back what you just typed means looking up at the chip. **Rejected.**
2. **Leave ordinary text behind, with the chip living its own life** — deleting the characters does
   not delete the chip. **Rejected, and this is a version this document changed**: the reasoning is
   below.
3. **Leave ordinary text behind, bound to the chip** (adopted here) — the text is still ordinary
   characters in the textarea, but backspace is atomic and its disappearance from the draft detaches
   (§2.3.1).
4. **Switch to contenteditable and make real rich tokens** — the native approach of Cursor's camp.
   **Rejected**: the IME's composition events, the undo stack, `maxLength` and accessibility
   read-out would all have to be written again. peek's first language of use is Chinese, and this box
   has already walked into a composition hole once (that `keyCode === 229` branch), which is not
   worth betting on a second time for a display effect. Approach 3 gets 4's behaviour out of three
   rules, at the sole cost of a mention having no background tint.

**Why 2 was overturned.** The reasoning at the time was: binding means comparing the draft against
the attachment list on every keystroke, which overturns the "the draft is not state" rule, and it
would bite — typing `@orders` by hand would attach automatically, and deleting the `s` would delete
the attachment first.

Neither holds up:

- **Typing by hand attaches nothing**, because the tracking table records only what was picked from
  the candidate list, and the direction is one way. That one was frightening myself at the time.
- **The "one character deleted" intermediate state can be eliminated**, and the way is atomic
  deletion — which is exactly what every rich-text mention plugin does, one backspace and the whole
  word disappears. I had taken "the problem atomic deletion solves" for "an inherent defect of the
  synchronising approach".
- **Reconciliation does not violate that constraint.** The constraint says the draft itself does not
  go on the Command Bus — it still does not, and before `chat.send` main does not know what the user
  typed. All that changes is: deleting a mention fires one `chat.detach`, once, exactly as clicking
  the × on a chip does. That is one user intent, not one keystroke.

And 2's cost is real: **nobody has seen that behaviour anywhere else.** Cursor's, ChatGPT's,
Notion's and Linear's mentions are gone once deleted; in Claude Code and GitHub's comment box `@x`
was only ever text, so deleting it removes it even more thoroughly. An input box where "the
characters are gone but the thing is still there" is not one the user credits with a position — they
just think it is broken.

### 3.2 Why merge into the composer, rather than make the attachment bar prettier

An attachment's lifecycle is exactly "the next message". Once merged, one box holds, top to bottom:
what to bring, what to say, and send — which is precisely what this message is made of. As two boxes
they are two things on the same level, when in fact one belongs to the other. The row of height saved
in the empty state is incidental, not the reason.

### 3.3 Why open a separate set of copy for chips, rather than write action copy that works in both places

It was tried in the head: `16 行` serving as both the button and the chip — the button loses its
verb, and a `primary` button reading `16 行` leaves what happens on click to guesswork. The two
positions' grammatical requirements are **opposite** (imperative sentence vs noun phrase), and one
string satisfying both can only do so by weakening both. One extra group of keys is the cheapest
solution here.

### 3.4 Why `@` cannot search the whole database's tables

`attachments.ts` established a principle: candidates offer only "the things the user is explicitly
looking at". Letting `@` find every table would need a cross-connection catalogue cache plus
asynchronous search, and it would turn "what is attached is the data in front of me" into "what is
attached is the table I remember being called that" — and the latter has to handle same-named tables,
unconnected connections, insufficient permissions and a pile of other cases. Left for later; if it is
ever really done, it is a reconciliation of its own.

### 3.5 Why the floating bar is kept, rather than letting `@` select rows too

`rowSelection` is `DataGrid`'s **local** state, not in the Workspace mirror (`ViewState` has no
selection field at all), so `attachCandidates` cannot see it. Making `@` able to list "the 16 selected
rows" would mean lifting the selection up into the mirror, at the cost of firing a Command on every
drag-select — `2026-08-14-grid-drag-selection.md` has just made drag-selection a mousemove-level
gesture, and this road would turn it into a string of patches.

The two roads each mind their own: the selection is in the grid, so the button for it is in the grid;
`@` minds the things that are "not in front of you, but already open".

## 4. Verification

**Unit tests** (all pure functions, following the existing `components/chat/__tests__/`):

- `mention.test.ts`: `findMention(text, caret)` triggering and not triggering (`@` at the start of a
  line, `@` after a space, `user@example.com` not triggering, an `@` followed by a space
  terminating), filter-term extraction, `applyMention`'s replacement result (`@ord` →
  `@public.orders ` with the caret landing after the trailing space, and a mid-sentence replacement
  not eating the characters after it), and `mentionToken` removing whitespace (`查询 1` → `查询1`).
- The three binding rules in the same file: `hasMention` respecting word boundaries (`@order` does not
  count as `@orders` still being there, `@public.orders,` does), `dropMention` deleting the word and
  taking the extra space with it, and `atomicBackspace` deleting the whole segment at once at the end
  of a mention and returning null elsewhere (handing back to the textarea itself).
- Added to `attachments.test.ts`: `attachCandidates` now produces schema candidates for table/vector/
  package views; chat views are still skipped.
- A `chipLabel` group: one case per kind, six in all, asserting the label contains no verb and does
  not repeat the kind segment.

**Manual steps**:

1. Open a table, drag-select 16 rows → the floating bar's button still reads `把 16 行加入对话` →
   click → the chip in the composer reads `行　orders · 16 行`, and the toast reads
   `已把 orders · 16 行 加入对话`.
2. Clear every attachment → the composer is left with the input and the action row only, the chips
   row takes no height, and the hint contains `@ 添加上下文`.
3. Type `@` in the composer → the candidate list appears immediately, with
   `输入名字筛选，↑↓ 选择，⏎ 确认` at the top; type `ord` → only orders-related items remain; `↓`
   `⏎` to pick → the draft becomes `@public.orders `, the caret is at the end, and the chip appears;
   then type `这张表有多少行` → the whole sentence reads properly; type `@` again → the orders item is
   marked as added and cannot be clicked.
4. Type `@zzz` → the candidate list **does not close** and reads `没有匹配的内容…`; press Esc → the
   candidate list closes and `@zzz` stays in the draft as it is.
5. Put the caret at the end of `@public.orders` and press backspace once → **the whole segment
   disappears**, and the chip disappears with it; selecting the whole sentence and deleting, or ⌘Z
   undoing back past the mention, makes the chip disappear just the same.
6. Click a chip's × → the chip disappears and the `@public.orders` in the body is deleted along with
   it, leaving no double space in the sentence.
7. Type (without the candidate list) `@orders 是什么意思` by hand → no attachment appears out of thin
   air, and deleting it affects none of the existing chips.
8. An `orders · 16 行` chip added from the grid has no corresponding characters in the body → editing
   the body in any way does not affect it, and only its own × can delete it.
9. Under a Chinese input method, type `@` and then pinyin and pick a character: with the candidate
   list open, Enter picks the **character** and the message is not sent.
10. On first use (with consent cleared) add the first attachment via `@` → the disclosure dialog
    appears as usual, and after accepting the attachment is still added, with no need to pick it
    again. Cancel → no chip, and that word stays in the draft: it is now simply a word, the tracking
    table's entry for it is void along with it, and deleting it or not affects no other attachment.
11. Add 16 in a row → the cap note appears at the top of the candidate list and every item becomes
    unselectable; removing one restores it.
12. Send → the chips clear, the body (including those `@public.orders` characters) is sent as the
    message body, and the chip names in the receipt below the message match what was in the composer.
