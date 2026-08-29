# The documentation goes English

> 2026-08-29. The repository is public, and 70 of its 80 tracked Markdown files
> carry their prose in Chinese — 346,575 Han characters, most of it the design
> record itself. This translates all of them, deletes the two bilingual
> counterparts whose English twin already exists, and reverses the rule from
> five days ago that said the older Chinese documents would never be translated
> back.

## 1. What this fixes

### 1.1 The repository reads in a language its code does not

`peek` is open source and its source comments are English. Its documentation is
not. Counting Han characters against total characters in every tracked `.md`:

| group | files | Han characters |
| --- | --- | --- |
| `docs/design/` written before 2026-08-24 | 62 | 316,000 |
| `docs/PLAN.zh-CN.md` | 1 | 14,893 |
| `README.zh-CN.md` | 1 | 2,224 |
| `design/icon-exploration/` | 3 | 2,452 |
| `CLAUDE.md` (repository root) | 1 | 608 |
| **total** | **70** | **346,575** |

Ten files are already English: `docs/PLAN.md`, `README.md`, the six design
records written on or after 2026-08-24, and
`apps/desktop/src/renderer/ui/CLAUDE.md`.

The split is not cosmetic, because the code points at the Chinese half. 221
comments across 131 source files cite a path under `docs/design/`, and almost
all of them land on a Chinese document:

```
apps/desktop/src/main/acp/manager.ts:470   → design/2026-08-06-opening-a-stored-conversation.md §1.1
apps/desktop/scripts/package-mac.mjs:53    → docs/design/2026-08-15-hardened-runtime.md
apps/desktop/electron.vite.config.ts:673   → docs/design/2026-08-04-tailwind-migration.md §4.4
```

A reader who follows one of those citations out of an English comment arrives at
a document they cannot read. The citation is the repository's own promise that
the reasoning is written down somewhere; for most readers of a public repository
that promise does not currently pay out.

### 1.2 This reverses a rule from five days ago

`CLAUDE.md` currently says, of the documents written before 2026-08-24:

> **此前的中文文档不回溯翻译**：它们是带时间戳的决策记录，重写会磨掉当时的判断痕迹。

*(The Chinese documents that predate this are not translated back: they are
timestamped decision records, and rewriting one sands off the traces of the
judgement made at the time.)*

That reasoning was sound about **rewriting** and wrong about **translating**.
Rewriting a decision record edits what it claims; translating one changes the
language it claims it in. The risk the rule guards against is real — a careless
translation flattens hedges, drops the "this was reversed on such a date"
asides, and turns an argument back into a summary — but that is an argument for
translating carefully, not for leaving two thirds of a public repository
unreadable.

The rule is therefore replaced, not quietly bypassed. §4 records what replaces
it.

### 1.3 Scope

This change covers tracked Markdown. Two things it deliberately does not cover,
for different reasons.

**The `zh-CN` message catalogue** under `apps/desktop/src/renderer/i18n` is a
product feature — the application's Chinese UI — and translating it would delete
a shipped capability. The same applies to the Chinese half of every
`label: { en: …, 'zh-CN': … }` pair in the package manifests, and to the test
assertions that check those strings come back correctly. None of it is prose
about the project; all of it is the project's output.

**Chinese comments in source** are the same problem as this document's, and are
left for a separate decision rather than folded in here. There are 4,949 Han
characters across 38 source files once the catalogue above is excluded, and they
are concentrated:

| file | Han characters | what they are |
| --- | --- | --- |
| `apps/desktop/src/renderer/styles.css` | 3,469 | the type and spacing ladders' rationale |
| `apps/desktop/src/renderer/__tests__/type-scale.test.ts` | 842 | why 11px is the floor |
| `apps/desktop/src/renderer/ui/spec.ts` | 336 | why the control height is arithmetic |
| 35 others | 302 | mostly one-line citations of a design record |

They are excluded because the scope agreed for this pass was the documentation,
and because separating them keeps the mechanical check in §5 honest: a source
file that legitimately holds a Chinese product string cannot be checked by the
same rule that says a Markdown file must hold none.

## 2. The plan

### 2.1 Sixty-eight documents are translated where they stand

Filenames do not change. This is the whole reason the 221 source citations
survive the pass without edits: `docs/design/2026-08-04-tailwind-migration.md`
still exists at that path, and still carries the same section numbers, so
`electron.vite.config.ts:673` still resolves. Section numbering is preserved
exactly, because 36 distinct design documents are cited by number from either
code or other documents.

Translation rules, in order of precedence:

1. **Claims are preserved, including the wrong ones.** A document that says a
   thing was tried and abandoned keeps saying that. Dates, measurements, file
   paths, identifiers and table figures are copied, not restated.
2. **Reversals stay marked.** Several documents carry `~~struck-through~~`
   passages with a later date and a reason. The strike, the date and the reason
   all survive.
3. **Register matches the existing English records.** The six documents from
   2026-08-24 onward set it: argument-first, evidence in tables, no summary
   paragraph the body does not earn.
4. **Technical identifiers are never translated.** `cursorToken`, `~/.peek`,
   `PEEK_*`, `@peek/*`, bundle IDs and CSS token names appear verbatim.

### 2.2 Two documents are deleted rather than translated

`docs/PLAN.zh-CN.md` and `README.zh-CN.md` each already have an English twin at
`docs/PLAN.md` and `README.md`. Translating them would produce a second English
copy of a document the repository already has. They are removed, and with them:

- the `[English](./PLAN.md) · **中文（原文）**` header line in `PLAN.zh-CN.md`
- the reciprocal link at `docs/PLAN.md:3`
- `README.md:228`, which calls `PLAN.zh-CN.md` the Chinese original
- `README.zh-CN.md:186` and `:212`, which go with the file

This costs the repository its Chinese README. That is the intended outcome of
the change, not an oversight: the decision recorded here is that the public
face of the project is English.

### 2.3 `CLAUDE.md` is translated and its rule rewritten

The repository's own collaboration convention is 55.9% Chinese, which makes it
the most conspicuous instance of the problem in §1.1. It is translated, and
while it is being translated the two clauses that this change invalidates are
rewritten — the "no retroactive translation" clause (§1.2) and the clause that
declares `PLAN.md` and `PLAN.zh-CN.md` jointly authoritative.

One clause is deliberately kept: conversation with the user stays in Chinese.
That is a preference about working, not about what ships in the repository, and
nothing here bears on it.

### 2.4 Then the history is rewritten

After the translation lands, `git filter-repo` removes the Chinese versions from
history. The cost is stated plainly because it is not small:

- 55 commits are rewritten; every SHA changes
- `v0.0.1` is retagged
- the three `claude/*` branches are built on the old history and are invalidated
- the push is a force push to a public repository
- objects already fetched by anyone who cloned or forked are not recalled, and
  GitHub may serve old SHAs by direct link until it garbage-collects

And the loss that is not mechanical: the design record's own evolution. 2,459
(file × commit) pairs disappear, which is every intermediate state of every
Chinese document. What survives is the final English text, with no history of
how it got there.

This is accepted knowingly. The alternative in §3.3 was offered and declined.

## 3. Trade-offs

### 3.1 Leave it alone

Cheapest, and defensible: the repository is bilingual, `README.zh-CN.md` exists,
and a reader who wants the English `PLAN.md` has it. Rejected because it leaves
§1.1 standing — 221 English comments citing documents most readers cannot read.

### 3.2 Delete the Chinese documents instead of translating them

Considered first, and it is what the change originally asked for. It resolves
§1.1 by making the citations dangle instead of by making them pay out, and it
throws away 346,575 characters of reasoning that took a month to accumulate. The
221 citations would then all need editing too, so it is not even the cheaper
option. Rejected.

### 3.3 Translate, but leave history alone

The recommended option, and declined. Once the working tree is English, a reader
arriving at GitHub sees English; the Chinese survives only in commits nobody
browses. It keeps every SHA stable, keeps the three branches alive, keeps the
design record's evolution, and is a single revertible commit.

The counter-argument that carried the decision: a public repository's history is
public too, and "you have to know to look" is not the same as not being there.

### 3.4 Translate history as well as the tree

Not possible at a sane cost. Making the *historical* documents English means
translating 2,459 file-versions, not 70 — `tailwind-migration.md` alone has
dozens of distinct snapshots. Nobody would read the result. This is why §2.4
deletes from history rather than translating within it.

## 4. The rule that replaces the old one

`CLAUDE.md` gains, in English:

> Documents in this repository are written in English. This includes design
> records: as of 2026-08-29 the Chinese ones have been translated, reversing the
> 2026-08-24 rule that said they would not be. Translating a decision record is
> allowed; rewriting one is not — claims, dates, measurements and struck-through
> reversals survive a translation unchanged.

## 5. Verification

Mechanical, in order:

1. **No Han characters remain in tracked Markdown.** A script counts
   `[一-鿿]` across `git ls-files '*.md'` and reports any file above
   zero. Expected: zero files. Quoted Chinese inside a translated document — the
   `CLAUDE.md` clause quoted in §1.2 of this document, for instance — is the one
   allowed exception and must be inside a blockquote with its translation
   adjacent.
2. **Every source citation still resolves.** For each of the 221 comments citing
   a `docs/design/` path, the path exists. Expected: 221/221.
3. **Every cited section number still exists.** For citations carrying a `§N.N`,
   that heading is present in the target. This is the check that catches a
   translation that renumbered.
4. **No link is left dangling.** Every relative Markdown link across `docs/`,
   `README.md` and `CLAUDE.md` resolves to a tracked file. This catches the
   `PLAN.zh-CN.md` and `README.zh-CN.md` removals in §2.2.
5. **`pnpm build` is green**, confirming nothing in §2.2's link edits touched a
   file the build reads.

By hand: spot-check the two largest translations, `tailwind-migration.md` and
`database-packages-from-disk.md`, against their originals for §2.1 rule 2 —
struck-through reversals are the detail a translation pass most easily drops,
and those two carry the most of them.

Before the §2.4 history rewrite, and separately from the checks above: the
pre-rewrite `master` is tagged locally so the whole operation can be abandoned,
and the force push is confirmed with the user rather than assumed from this
document.
