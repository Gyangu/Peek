# Spec Kit takes over the per-change design record

> 2026-09-11. New work goes through GitHub's Spec Kit (`/speckit-specify` →
> `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`) and lands under
> `specs/NNN-short-name/`. This is the last record written under `docs/design/`;
> the 73 that precede it are frozen, not moved, because 224 source comments
> point at them.

## 1. What this fixes

### 1.1 Where things stand

Every change to this repository already goes through a document before it goes
into the code. `CLAUDE.md` fixes the order — look for conflicts, settle them
with the user, update the record, then implement — and the record is one file
per change under `docs/design/YYYY-MM-DD-topic.md` with four mandatory
sections: what this fixes, the plan, trade-offs, verification. `docs/PLAN.md`
carries the global picture and is updated after the fact.

That process is home-grown. It has no template beyond the four headings, no
prompt that asks the questions a spec should answer before planning starts, no
task list separate from the plan, and no way to check the three against each
other. Each of those is something the author reconstructs per document.

### 1.2 What is being asked

Use [Spec Kit](https://github.com/github/spec-kit) in this repository. Spec Kit
is a scaffold for spec-driven development: a CLI (`specify`) installs a set of
agent skills that walk a change through fixed stages, each producing one file
in a per-feature directory:

| stage | skill | output |
| --- | --- | --- |
| principles | `/speckit-constitution` | `.specify/memory/constitution.md` |
| requirements | `/speckit-specify` | `specs/NNN-name/spec.md` |
| (questions) | `/speckit-clarify` | edits `spec.md` in place |
| technical plan | `/speckit-plan` | `specs/NNN-name/plan.md` (+ `research.md`, `data-model.md`, `contracts/`, `quickstart.md` when the plan calls for them) |
| task list | `/speckit-tasks` | `specs/NNN-name/tasks.md` |
| consistency | `/speckit-analyze` | a report, no file |
| implementation | `/speckit-implement` | code |
| drift check | `/speckit-converge` | appends remaining work to `tasks.md` |

The plan stage has a **Constitution Check** gate: the plan cannot proceed until
it has been measured against the constitution, and any violation has to be
justified in a table. That gate is the hook the existing process needs — it is
where "look for conflicts with what is already designed" can live as a
mechanical step instead of a sentence in `CLAUDE.md`.

### 1.3 The conflict, and how it was settled

The two processes do the same job in different shapes:

| | `CLAUDE.md` (until today) | Spec Kit |
| --- | --- | --- |
| decision record | `docs/design/YYYY-MM-DD-topic.md`, one file per change | `specs/NNN-name/`, one directory per feature, three or more files |
| global principles | `docs/PLAN.md` | `.specify/memory/constitution.md` |
| document shape | four fixed sections | its own templates (user stories, requirements, success criteria) |
| conflict detection | a rule the author is expected to follow | the plan template's Constitution Check gate |
| trade-offs and verification | mandatory sections | not in the stock plan template |

Three options were put to the user on 2026-09-11:

1. borrow only the questions — run `/speckit-specify` for the interview, but
   write the result into `docs/design/` in the old shape, and keep `specs/` out
   of the repository;
2. adopt Spec Kit fully — new work goes to `specs/`, `CLAUDE.md` is rewritten
   around it, `docs/design/` stays as an archive;
3. do nothing — the existing process already covers the core idea.

**The user chose 2.** This record is the settlement.

### 1.4 Boundary (not done here)

- **`docs/design/` is not moved, renamed or reformatted.** 224 comments in the
  source cite a path under it, and `scripts/verify-docs-english.mjs` checks
  that every citation resolves. Those records are timestamped decisions; the
  argument that kept them unrenamed through the `peek` → `Peek` rebrand
  (`docs/PLAN.md`, front matter) and through the translation
  (`2026-08-29-the-documentation-goes-english.md` §1) holds here too.
- **`docs/PLAN.md` keeps its role** as the global plan. The constitution is
  distilled from it, not a replacement for it; a change to the architecture
  still updates `PLAN.md` afterwards, as before.
- **No feature branches.** Spec Kit 1.0.7 moved branch creation out of the core
  scripts and into an optional `git` extension, which is not installed. Work
  keeps happening on `master` the way it does now.
- **No presets, no extensions, no GitHub-issue export.** `/speckit-taskstoissues`
  is installed because the integration ships it, but nothing here uses it.
- The Spec Kit templates are not rewritten. One is extended (§2.3); the rest are
  used as shipped.

## 2. The plan

### 2.1 What lands in the repository

```
.claude/skills/speckit-*/SKILL.md      # ten skills, installed by `specify init`
.specify/
├─ memory/constitution.md              # filled in from PLAN.md and CLAUDE.md (§2.4)
├─ templates/                          # stock templates, untouched
├─ templates/overrides/plan-template.md  # the one extension (§2.3)
├─ scripts/bash/                       # stock helper scripts
├─ workflows/, integrations/, *.json   # CLI bookkeeping
└─ .gitignore                          # feature.json is per-checkout state
specs/                                 # empty until the first feature
```

`.specify/init-options.json` records `speckit_version`, so the CLI that
generated the tree is on record. The CLI itself is installed per machine:

```
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
```

### 2.2 Where each old rule goes

| the old rule (`CLAUDE.md`) | where it lives now |
| --- | --- |
| look for conflicts before starting | the constitution (§2.4) states the standing decisions; `/speckit-plan`'s Constitution Check measures the plan against them |
| a conflict stops the work until the user decides | kept verbatim in `CLAUDE.md` and in the constitution's Governance section — Spec Kit has no such step of its own, so it stays a rule the agent follows |
| update the document, then implement | the stage order itself: `spec.md` and `plan.md` exist before `/speckit-implement` runs |
| four mandatory sections | *what this fixes* → `spec.md` (user scenarios, requirements, out of scope); *the plan* → `plan.md`; *trade-offs* and *verification* → two sections added to `plan.md` by the override (§2.3) |
| English only | unchanged; `scripts/verify-docs-english.mjs` walks `git ls-files '*.md'`, so `specs/**/*.md` and `.specify/**/*.md` are covered without a change to the script |
| `PLAN.md` is updated afterwards, never diluted | unchanged |
| no document for typo/format/version bumps | unchanged |

The minimum for one change is `spec.md` + `plan.md`. `tasks.md` is written when
the implementation is more than one sitting; for a small change the plan's
verification section is the task list.

### 2.3 The plan template override

`.specify/templates/overrides/plan-template.md` is the stock plan template with
two sections appended before *Complexity Tracking*:

```
## Trade-offs
## Verification
```

The override mechanism is Spec Kit's own (`common.sh`, `resolve_template_content`:
overrides win over presets, extensions and core), and the CLI preserves the
`overrides/` directory on refresh. The cost is that an upstream change to the
stock plan template is shadowed until someone re-applies it to the override;
the mitigation is that the override is the stock file plus two headings, so
re-applying is a copy and a paste.

### 2.4 The constitution

`.specify/memory/constitution.md` is written by hand for this first version —
the `/speckit-constitution` skill is an interview, and the answers already
exist in `docs/PLAN.md` and `CLAUDE.md`. It carries:

1. the architectural decisions that are settled and that every plan must be
   checked against — the process model, the command bus as the only write path
   to workspace state, the read-only scope, the capability model, the
   performance budget (`docs/PLAN.md` §3, §4, §6, §8, §10 "Settled" and
   "Deliberately not doing");
2. the repository rules — English in the repository, Chinese in conversation;
   `pnpm test` is the gate; conventional commits; no co-author trailer;
3. the process rules — a conflict with a standing decision stops the work
   until the user settles it; `docs/design/` is read-only history; `PLAN.md`
   is updated after a change that alters the global picture.

It cites `docs/PLAN.md` section numbers rather than restating them, so it stays
short and cannot drift from the plan without the citation going stale.

### 2.5 Files edited

- `CLAUDE.md` — the "every change goes through the documents" section is
  rewritten around the Spec Kit stages. The order, the stop-on-conflict rule,
  the English rule and the `PLAN.md` rule survive; the `docs/design/` naming
  convention becomes a note about the archive.
- `.prettierignore` — `.specify/` is added. Three CLI-managed files
  (`integration.json`, `workflows/speckit/workflow.yml`,
  `workflows/workflow-registry.json`) fail `prettier --check` as generated,
  and the same reasoning that excludes `dist/` and `node_modules/` applies:
  not ours to format, and the CLI rewrites them on refresh.
- `README.md` — the repository-layout block gains `specs/` and `.specify/`, and
  the sentence that says where per-change design docs live is updated.
- `docs/PLAN.md` — one entry under §10 "Settled" pointing here.

## 3. Trade-offs

### 3.1 Option 1 — borrow the interview, keep the old shape

This would have kept a single document shape and left `.specify/` out of git.
It lost because the value of Spec Kit is not the interview alone; it is that
`spec.md`, `plan.md` and `tasks.md` are separate artefacts with a checker
(`/speckit-analyze`) that reads all three, and a Constitution Check that runs
before planning. Writing the result back into one four-section file discards
both.

### 3.2 Option 3 — nothing

The old process was working: 73 records, every one of them cited from the code
that implemented it. What it lacked was a fixed set of questions before the
plan and a mechanical conflict check. Those are exactly the two things Spec Kit
adds, and they are cheap to add now, before the next milestone starts.

### 3.3 Sequential numbers instead of dates

`docs/design/` is named by date; `specs/` is named by sequence
(`001-short-name`). Spec Kit also offers `--timestamp` (`YYYYMMDD-HHMMSS`
prefix). Sequential was kept: it is the default the skills and scripts assume,
and the `**Created**` line at the top of every `spec.md` carries the date
anyway.

### 3.4 Override versus constitution-only

The trade-offs and verification sections could have been demanded by the
constitution alone and left to the agent to add. That is the shape of rule the
old process relied on, and the reason for adopting Spec Kit is to turn rules
into template structure where possible. The override costs one file.

### 3.5 Not installing the `git` extension

The extension creates a branch per feature and commits per stage. The
repository works on `master` with hand-written commit messages
(`development-rules` skill), and nothing in the settlement asked for that to
change. It can be added later with `specify extension add git` without
touching anything decided here.

## 4. Verification

1. `specify check` reports the Claude integration as installed.
2. `.specify/scripts/bash/create-new-feature.sh --dry-run --json 'smoke'`
   prints a path under `specs/001-…` and creates nothing.
3. `.specify/scripts/bash/resolve-template.sh plan-template` returns the
   override (its output contains `## Trade-offs` and `## Verification`).
4. `pnpm test` passes — in particular `check:docs` (no Han characters in any
   tracked Markdown, including the ten new `SKILL.md` files and the templates;
   every `docs/design/` citation still resolves) and `format:check` (with
   `.specify/` ignored).
5. `git status` shows `.specify/feature.json` is not tracked after a feature
   is created.
