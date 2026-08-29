# The settings dialog's width: 760 → 800

Follows on from `2026-08-04-settings-form-gutter.md`. That document fixed the
label column's misalignment; this one fixes the other half of why the dialog
still felt cramped once aligned — the box itself is twenty-odd pixels short.

## 1. What this fixes

### Where things stand

```css
.modal {
  width: min(760px, 86vw);   /* styles.css:1587 — every dialog */
}

.settings-modal {
  width: min(760px, 90vw);   /* styles.css:1687 */
  height: min(560px, 84vh);
}
```

Note that the 760 on those two lines is **the same 760**: all the
`.settings-modal` override actually changes is `86vw` → `90vw`, and the width
itself is copied from the generic dialog. Which is to say the settings dialog has
never been measured on its own — it is wearing the connect dialog's clothes.

The connect dialog holds four or five inputs and 760px is ample. The settings
dialog holds the "Databases" section: a six-row, three-column table whose longest
cell is `introspect · tabularQuery · collectionScan · valuePeek · cancel`, and
those capability names are **deliberately not translated** (the comment in
`PackagesSection.tsx` gives the reason: they are the contract's vocabulary and
have to match an MCP receipt word for word).

### The problem

Measured by hanging the three real stylesheets on a static page and reproducing
this section against the real DOM:

| quantity | value |
| --- | --- |
| dialog width | 760 |
| pane width (less the 148px sidebar) | 610 |
| pane content width (less 10px padding ×2) | **590** |
| required for three columns not to wrap (79 + 70 + 465) | **614** |

Twenty-four pixels short. So all six capability rows wrap to two lines, `cancel`
drops onto a second line by itself, and the "Connector version" header is
squeezed onto two lines as well. The section grows from six rows to twelve, which
is exactly enough to fill the 560px height.

The critical widths, swept:

| language | dialog width at which the table stops wrapping entirely |
| --- | --- |
| zh-CN | **784** |
| en | **786** (`Connector` is narrower than `连接器版本`, but `Capabilities` is wider; net 2px) |

Those twenty-odd pixels are what 760 is short by. Not a design conviction —
nobody measured.

### Boundary (explicitly not done)

- **The height does not change.** 560px was set by the longest section, and this
  change makes the "Databases" section *shorter* (six rows no longer wrapping to
  twelve). `settings-panel.md` has already argued that the height must be fixed —
  a dialog that follows its content moves the sidebar out from under the cursor
  as you click it.
- **`.modal`'s 760 does not change.** The connect dialog does not have this
  problem, and widening it in sympathy only makes four inputs look emptier.
- **How the capability names are presented does not change** (no vertical list,
  no abbreviation). See §3.
- **`--form-label-w` does not change.** "Which permission a new conversation
  starts in" is still two lines; the reasoning is in `settings-form-gutter.md`
  §3, and a wider dialog does not alter that judgement.

## 2. The plan

One line:

```css
.settings-modal {
  width: min(800px, 90vw);
}
```

800 rather than 784/786: the critical values sit exactly on the content, and a
one-word copy change would start it wrapping again. 800 leaves 14px of slack in
both languages and is a round number that needs no explanation.

**The `90vw` half will never bite in practice.** The main window has
`minWidth: 900` (`main/index.ts:432`), and 900 × 0.9 = 810 > 800. So at 100%
scaling the dialog always gets its full 800px. `min()` stays because interface
scaling shrinks the CSS viewport — at the 1.5 step, 900 physical pixels is only
600 CSS px, 90vw is 540px, the dialog is squeezed, and the table wraps again.
That is the trade-off scaling is *supposed* to make (bigger text, less on
screen), and `.pkg-caps { white-space: normal }` is the degradation prepared for
exactly that moment, not something to fix.

The hard-coded "760px dialog" in the comment at `styles.css:1828` is updated
along the way.

## 3. Trade-offs

**Not widening, and making the capability column take less room, was
considered.** Three versions were thought through: replacing the `·` separators
with a vertical list (the table immediately grows to thirty rows), abbreviating
the capability names (a direct violation of the written rule that they must match
an MCP receipt word for word), and moving the capabilities into a hover tooltip
(hiding visible information to save 24px). Every one costs far more than making
the box 40px wider.

**Shortening only zh-CN's `连接器版本` to `版本` was considered.** The version
column would drop from 70px to 45px and zh would land at 759px — just enough. But
the English header is `Connector`, which saves nothing, and still needs 786px. A
fix that only works in one language is a fix that leaves the bug to the other.

**Sizing to content (`width: max-content` with a ceiling) was considered.** Then
every section would have a different width, the dialog would jump horizontally as
you clicked between categories in the sidebar, and the sidebar would shift out
from under the cursor — precisely the reason `settings-panel.md` rejected
"height follows content", and it is more obvious horizontally.

**Going to 880 or 900 and being done with it was considered.** Nothing supports
those numbers, and every pixel of extra width is another pixel of white space to
the right of the other five sections — all of which are forms, for which width is
a cost with no benefit. 800 is the smallest round number the measurements
support.

## 4. Verification

- Sweep the static reproduction's width (700→1000, 2px steps) and confirm: zh's
  table has no wrapping cell from 784px, en from 786px, and at 800px both have
  zero wrapped cells.
- `pnpm --filter @peek/desktop typecheck` / `test` — a pure CSS change, all
  green.
- By hand:
  1. **Databases** — each of the six capability rows occupies one line and
     `cancel` no longer drops on its own; the "Connector version" header fits on
     one line; the section is visibly shorter and no longer fills 560px.
  2. Switch to English and look at the same section again.
  3. The other five sections (MCP endpoint / chat agent / appearance / queries
     and timeouts / about) should show 40px more white space on the right and no
     column shifted at all — their layout is set by `--form-label-w` and is
     independent of the dialog's width.
  4. Drag the main window to its minimum (900px) and confirm the dialog is still
     a full 800px rather than 810's 90vw.
  5. Set interface size to 150% and confirm that once the dialog is squeezed to
     90vw the table wraps without overflowing and without scrolling
     horizontally.
