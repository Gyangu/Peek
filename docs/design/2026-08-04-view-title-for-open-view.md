# `open_view`'s title: letting the model know it may name a view

## 1. What this fixes

### Where things stand

The `title` field **already exists**, and the whole path through it works:

- `packages/core/src/commands.ts` — all seven view specs (table / query /
  inspector / tree / vector / chat / package) carry
  `title: z.string().optional()`, and so do the seven branches of
  `ViewPatchSchema`, so `view.update` can change it.
- `apps/desktop/src/main/bus/handlers/shared.ts:493` — `buildViewState` puts it
  into `ViewState.title`.
- Both readers honour "an explicit title wins, otherwise derive from content":
  - `packages/core/src/workspace.ts:1064` `viewTitle()` — English, feeding MCP
    and the workspace snapshot.
  - `apps/desktop/src/renderer/components/panelTitle.ts:19` `viewTitleOf()` —
    localised, drawn on the tab strip, the drag label and the swap preview.

### The problem

The MCP layer has never mentioned that the field exists.

- All fourteen `title` fields are a bare `z.string().optional()` with not one
  `.describe()`, so what reaches the model in the JSON Schema is a
  `title?: string` with no explanation attached.
- `open_view`'s tool description spends paragraphs on panel placement,
  `replace` and `index`, and says nothing at all about titles.

The result: the feature works, but the AI never reaches for it. Views a person
opens read tolerably because `viewTitleOf` derives something like
`public.orders`; an AI that opens three query views in a row produces three tabs
all reading `Query`, indistinguishable — and the AI is precisely the party that
knows why it opened each one.

### Boundary (explicitly not done)

- **No new field.** No separate "purpose" note alongside the title.
  `read_workspace` already has `describeView()` deriving a sentence from content
  (`Table public.orders · offset 0 limit 100`); a second, model-authored, longer
  description would overlap with its job.
- **No data structure changes and no runtime behaviour changes.** The only thing
  this touches is the documentation text exposed to the model.
- **No length ceiling.** Reasoning in §3.

## 2. The plan

### 2.1 One shared title schema (`packages/core/src/commands.ts`)

Repeating the same `.describe()` text in fourteen places is unmaintainable. This
follows the `autoRefreshMs` convention the file already has — a module-level
constant referenced by every branch that needs it:

```ts
const viewTitle = z.string().optional().describe(...)
```

All seven members of `ViewOpenSpecSchema` and all seven branches of
`ViewPatchSchema` switch to it. Because `open_view`'s `InputSchema` is
`commandSchemas['view.open'].safeExtend(...)`, the description propagates into
the MCP JSON Schema on its own, and the tool does not have to restate the field.

The description has to convey three things; drop any one and the model uses it
wrongly:

1. **What it is for** — the name shown on the tab, saying what this view is or
   why it was opened.
2. **What omitting it does** — not an error, but derivation from content (table
   name, `Query`, `Chat`). So a view that already explains itself (browsing
   `public.orders`) needs no title, and forcing one on it is worse than nothing.
3. **How short** — a few words, not a sentence. It has to fit the tab strip.

### 2.2 `open_view`'s tool description (`apps/desktop/src/main/mcp/tools/open-view.ts`)

A sentence after the tab-placement material, handing over the judgement of *when*
a name is worth giving: when several views of the same kind are opened in one
panel — several queries especially — the derived titles collapse into each
other, and `spec.title` is the only way to tell them apart.

The field's own semantics are not repeated here; that is §2.1's `.describe()`'s
job, and writing it in both places is two documents that will diverge.

### 2.3 Data flow

Unchanged. `open_view(spec.title)` → `view.open` → `buildViewState` →
`ViewState.title` → `viewTitle()` / `viewTitleOf()`. This change touches no line
of runtime code.

## 3. Trade-offs

**A length ceiling (`z.string().max(80)`) was considered and rejected.**

This file generally puts a ceiling on model-writable fields
(`MAX_CHAT_PROMPT_CHARS`, `MAX_CHAT_ATTACHMENTS`) on the grounds that "a Command
can now be authored by a model", and a model is perfectly capable of putting a
paragraph in a tab title.

But a ceiling turns input that is legal today into `BAD_REQUEST`, which is a
behaviour change and outside "let the AI know this field exists". The failure
modes are also asymmetric: an over-long title costs one line of truncated text on
the tab strip, and CSS absorbs it; rejecting the command costs an `open_view`
that should have succeeded. The first is much the lighter.

Writing "a few words" into `.describe()` is the thing to try first. If models are
in fact observed writing sentences, the ceiling can come back then — as a
separate change with evidence behind it.

**Changing only the tool description and leaving core's schema alone was
considered.** That leaves core untouched, but the `view.update` route to changing
a title stays undocumented, and a field's documentation sitting in a tool
description while the field sits in core is two things that will drift apart.
`.describe()` keeps the explanation attached to the field, and both `open_view`
and `update_view` pick it up for free.

## 4. Verification

- `pnpm --filter @peek/core test` — a schema change should disturb no existing
  assertion (`title`'s type and optionality are unchanged; only description
  metadata is added).
- `pnpm --filter desktop test` — `mcp/__tests__/tool-surface.test.ts` and
  `layout-tools.test.ts` above all.
- Typecheck: the type inferred for the `viewTitle` constant must still be
  `string | undefined`, or the narrowing of `spec.title` in `buildViewState`
  will error.
- By hand: have the AI open two query views in one panel and confirm the tab
  strip shows two distinguishable titles rather than two reading `Query`; then
  confirm that opening a table browse without a `title` still shows
  `public.orders` on the tab and not a blank.
