# Settings › Keyboard: arranging a pile of rows into one table

## 1. What this fixes

### 1.1 Where things stand

`KeyboardSection` puts each of the six scopes into a `FormRow`: the scope's name
becomes the label (right-aligned, landing in the form's label column) and a whole
group of shortcuts becomes the "control", stuffed into the form grid's second
column.

```tsx
<FormRow label={t(SCOPE_LABEL[scope])}>
  <div className="flex flex-col gap-tight min-w-0">{/* every row in this group */}</div>
</FormRow>
```

### 1.2 The problems

**First, the key column is scattered.** `form-field` is `display:flex`, and
`flex: 1` is given only to `& > input, & > select` (see `@utility form-field` in
`styles.css`). The `div` holding a group of rows is not an input, so it **shrinks
to its content** and every group forms a box of a different width. Inside a group
each row is `label flex-1` plus the keys, so the keys align to **that group's**
right edge, and the groups' right edges have nothing to do with one another.
Measured, five groups' right edges land in five different places (the "app menu"
group is the narrowest, about 130px left of the "result grid" group). On screen:
⌘A, ⌘C, Escape, Enter and ⌘0 share no vertical line.

This is not somebody drawing crookedly; it is the inevitable result of pushing a
group of rows into the control column as though it were one control. The control
column's sizing rule was written for a single control.

**Second, one table has two renderings.** A rebindable row is "a bordered keycap
button plus a ghost button reading Default on its right"; a non-rebindable row is
"a run of grey monospace text". The two alternate vertically and it looks as
though the page half broke while rendering. The difference is **meaningful**
(can you change this or not), but not a word explains it today, so all the user
sees is inconsistency.

**Third, "Default" is permanent noise.** `keys.settings.reset` reads "Default"
and is **always shown**. It looks like a status label ("this one is the default")
and is in fact an action button ("restore the default"). A column that is always
present and has nothing to do nine tenths of the time is the lowest information
density on screen.

**Fourth, there is no boundary between groups.** Just a little spacing, with
membership inferred from a group name floating off to the left. This section is
long enough to scroll, and halfway down there is no way to tell whether "exit the
text editor" belongs to the group above or the one below.

### 1.3 Boundary

**Done:** the layout of `KeyboardSection` and two pieces of copy.

**Not done:**

- `keys/` is untouched: the registry, the chord syntax, the binding table,
  conflict detection and persistence all stay. The capture logic (`onKeyDown`,
  `⌫` to clear, `Esc` to abandon) is preserved as it is.
- `ShortcutSheet` is untouched. It is already "a section heading plus rows
  justified to both edges", and this change moves settings towards it, not the
  reverse.
- `ui/Form.tsx` does not change. See §3.1.
- Rebinding is not opened up for non-rebindable rows.
  `2026-08-15-keyboard-system.md` §3.2 settled that, and this does not overturn
  it.

### 1.4 Relationship to the existing documents

`2026-08-13-settings-form-primitives.md` established "the form vocabulary is an
API": one row is one label plus the control it names. This change moves the
keyboard section **out** of that vocabulary — not in violation of it, but in
acknowledgement that this section is not a form: a scope name is not any
control's label, and a group of shortcuts is not one control. The label column
width that `2026-08-04-settings-form-gutter.md` cares about no longer applies
here (this section no longer has a label column), and the other sections are
unaffected.

## 2. The plan

### 2.1 Layout: a section heading, and a right-aligned key column

Each scope becomes a `<section>`: a left-aligned heading (`text-fg-dim
font-semibold`, spelled the same way as in the shortcut sheet) above rows
spanning the full width. A `border-t border-border` rule separates the groups.

A row, left to right:

```
[ description flex-1 truncate ] [ reset to default (only when changed) ] [ keys ]
```

The keys go **furthest right** and the description takes the middle with
`flex-1`. So every row's **right edge of keys** lands on the same vertical line —
whichever group it belongs to, rebindable or not, whether the keys are `⌘A` or
`⌘⌥⇧←↑↓→`. This is also how macOS menus lay keys out.

The "reset to default" button is inserted to the **left** of the keys rather than
the right: it appears on demand, and on the right it would shove the keys aside
the moment it appeared, making a column of aligned keycaps jump in unison as the
user rebinds. On the left, the `flex-1` description column absorbs the width
change and the keys do not move.

### 2.2 Both renderings stay, but the difference is explained

A rebindable row stays a keycap button (click to capture) and a non-rebindable
row stays grey text — that difference is exactly "can you change this one", and
is worth seeing. What is missing today is the explanation, so a group-level hint
is added:

> These are conventions the system defines and cannot be changed.

It shows only when the whole group is non-rebindable (scope and rebindability are
one-to-one today, but the code still decides by "does this group contain a
rebindable entry" rather than hard-coding that coincidence).

The two renderings are also made **geometrically consistent**: the same
`font-mono`, the same row height. The height is set by the keycap button
(`size md` = 24px) and read-only rows take the same, so the vertical rhythm does
not stutter between the two kinds.

### 2.3 "Default" becomes an on-demand "Reset"

- The copy for `keys.settings.reset`: `默认` → `恢复默认`; en `Default` →
  `Reset`.
- Rendered only when the current binding differs from `DEFAULT_BINDINGS`. The
  test has to cover all three kinds of difference: a default exists and the
  current is `null` (the user turned it off), no default and a current exists,
  and both exist but `sameChord` is false.

### 2.4 Data flow

None. No new state, no new IPC, no change to the shape of `settings.json`.

## 3. Trade-offs

**First, adding a "block children fill" rule to `form-field` and keeping the
`FormRow` usage was considered.** Rejected: it would change the second column's
behaviour for every `FormRow` in the repository — changing every correct call
site for the sake of one that misuses it. And it would only solve the first
problem; the second, third and fourth would remain exactly as they are.

**Second, a grid (`1fr auto auto`) to align the three columns was considered.**
Rejected, for the reason already written down in `ShortcutSheet`: the track
widths would be written as arbitrary values, and a literal hung on a family is
invisible to the token guard. Justifying each row to both edges looks the same
and needs no tracks.

**Third, making read-only rows into disabled keycap buttons to eliminate the two
renderings entirely was considered.** Rejected: the existing comment in
`KeyboardSection` gives the reason — there is no disable-able action here, and a
disabled button says "this feature is broken" when the fact is "this one is like
this by design". The difference should not be flattened, it should be explained
(§2.2).

**Fourth, keeping "Reset" always present but greyed out was considered.**
Rejected: that is still the same column of noise, only dimmer. Appearing on demand
also communicates "you have changed this one", which is information that does not
exist at all today.

## 4. Verification

- `pnpm --filter @peek/desktop typecheck`
- `pnpm --filter @peek/desktop test` — this section has no component test, and the
  run is to confirm the i18n directory's completeness guard (en / zh-CN key sets
  matching) still passes.
- By hand (`⌘,` → Keyboard):
  1. Scroll top to bottom; every key's right edge (read-only rows included) is on
     one vertical line.
  2. All six groups have a heading and a separating rule; the group names are
     left-aligned.
  3. Each read-only group carries a "cannot be changed" note beneath it.
  4. Change a window shortcut → "Reset" appears on that row, the other rows do
     not move, and the key column does not shift; click it → the button
     disappears and the key returns to its default.
  5. Change one into a conflict with another → the conflict notice still appears
     beneath that row (not lost in the redesign).
  6. Go through it once in English; longer labels must not cost the key column
     its alignment (long labels truncate).
