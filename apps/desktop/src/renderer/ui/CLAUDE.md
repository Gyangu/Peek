# `renderer/ui/` — the control layer

Read this before adding or restyling any control. It is short on purpose.

Design record: [`docs/design/2026-08-02-control-spec.md`](../../../../../docs/design/2026-08-02-control-spec.md)

## The one rule

**Never write a bare `<button>` in `renderer/`. Never invent a CSS class that
changes how a control looks.**

Both are enforced by `__tests__/control-spec.test.ts`, not by review.

```tsx
import { Button } from '../../ui/Button'

<Button variant="danger" size="sm" onClick={forget}>Remove</Button>
<Button variant="ghost" icon label="Close tab" onClick={close}>✕</Button>
```

## Picking a variant

Pick by **what the action means**, never by what you want it to look like. The
authoritative list, with an `intent` sentence for each, is `spec.ts` —
`BUTTON_VARIANTS`. Read it; it is thirty lines and it is the answer.

| | |
|---|---|
| `primary` | the one action this view exists for. At most one per container |
| `default` | a real action, but not the one the view is about |
| `ghost` | must not compete for attention |
| `danger` | destructive or irreversible |
| `caution` | not destructive, but the consequence outlives this moment |

Two sizes: `md` (24px, the default) and `sm` (20px, inline in a compact strip).
There is no third size. If neither fits, that is a spec question — see below.

## When the spec is not enough

This is the part that matters, because it is the step that got skipped and
produced the mess this layer exists to clean up.

There were three separate implementations of "destructive" in this codebase —
`.confirm-danger`, `.chat-perm-reject` and `.chat-stop` — two of them
byte-for-byte identical. Nobody was careless. Each author needed a red button,
found no place to look and no place to add, and did the only remaining thing.
The third one was written by an agent, in this repo, one day before this layer
existed.

So: **do not solve it locally.** If you need something `spec.ts` cannot express:

1. Add the variant (or size) to `spec.ts`, with a real `intent` sentence. A
   variant whose intent you cannot state in one line is a variant named after
   its colour, which is the thing this spec exists to prevent.
2. Add its rules to `controls.css` — **all five states**. The contract test
   fails if you define three of them.
3. Write it down in a design doc under `docs/design/`, per the repo's
   docs-before-code rule in the root `CLAUDE.md`.

That path is longer than adding a class. It is supposed to be: every step of it
leaves the next reader something to find.

## Escape hatches

- `style` — typed `never`. There is no way through. This is not an oversight.
- `className` — allowed, **layout only** (position, margin, flex, transform).
  The test looks your class up in the stylesheets and fails if it declares a
  colour, a border, a font size or a box size. Those belong to the spec.

## The runtime attributes

`action` and `exposure` are optional and nothing consumes them yet.

- `action` is a stable `domain.verb` handle, matching the Command Bus vocabulary
  (PLAN §6). Use it for controls a test needs to find, and for icon-only buttons.
  Ids must be globally unique — the test checks.
- `exposure` says who may operate the control: `human-only` (the default) or
  `agent-ok`. It is reserved for the day peek lets an agent drive controls
  directly. **Do not mark a permission-prompt button `agent-ok`** — an agent that
  can approve its own permission requests has no permission system. There is a
  test for exactly that.

## Seeing your work

`Gallery.tsx` renders every variant × state × size. In a dev build it is at the
bottom of the settings dialog's About section. Open it after changing anything
here — including if you are an agent: a screenshot is the only way you will ever
see what you just wrote.

## Not yet migrated

`control-spec.test.ts` holds an allowlist of files still using bare `<button>`.
The list may only get shorter. If you are working in one of those files anyway,
migrating it and deleting its line is welcome. Do not add to it.
