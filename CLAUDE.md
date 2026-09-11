# Peek — working conventions

## Every change goes through the documents

Any change that touches behaviour, structure or interaction goes **through the
documents before it goes into the code**. The documents stay in the repository
and are committed alongside the code, as the decision record for that change.

Since 2026-09-11 the documents are produced by
[Spec Kit](https://github.com/github/spec-kit)
(`docs/design/2026-09-11-spec-kit-adoption.md`). The order is fixed:

1. **`/speckit-specify`** — describe the change. This writes
   `specs/NNN-short-name/spec.md`: user scenarios, requirements, success
   criteria, and what the change explicitly does not do. Run
   `/speckit-clarify` when the description leaves questions open.
2. **`/speckit-plan`** — the technical plan, `specs/NNN-short-name/plan.md`.
   Its **Constitution Check** measures the plan against
   `.specify/memory/constitution.md`, which lists the decisions already made
   (and cites `docs/PLAN.md` for the details).
3. **A conflict is settled first** — if the check finds that what is being
   asked contradicts a standing decision, list the conflict explicitly for the
   user: what the documents decided, what is being asked now, and where the two
   fail to line up. **Stop and wait for the user to say which side wins.** Do
   not pick one and carry on. Spec Kit has no step for this; it is a rule.
4. **`/speckit-tasks`** — `tasks.md`, when the implementation is more than one
   sitting. For a small change the plan's Verification section is the task
   list. `/speckit-analyze` checks spec, plan and tasks against each other.
5. **`/speckit-implement`** — the code follows the documents. If the design
   turns out not to work during implementation, go back to step 3 and settle
   it again; do not let the code and the documents quietly diverge.

Documents:

- Location: `specs/NNN-short-name/` — one directory per change, numbered in
  sequence by `/speckit-specify`.
- **Language: English.** Documents in this repository are written in English.
  The reason is that the repository is open source and the source comments were
  always English — 224 comments point at `docs/design/`, and the documents have
  to follow so that readers do not hit a language wall between a citation and
  its target (`docs/design/2026-08-29-the-documentation-goes-english.md`).
  `pnpm test` enforces it. Conversation with the user stays in Chinese; this
  rule governs only what is written into the repository.
- `plan.md` carries two sections beyond the stock Spec Kit template, added by
  `.specify/templates/overrides/plan-template.md`:
  1. **Trade-offs** — the other approaches considered, and why they lost
  2. **Verification** — how to confirm the change is right (manual steps or
     tests)

Exception: changes with no design space in them — plain typo fixes, formatting,
dependency version bumps — need no document. When in doubt, write one; a short
document beats reconstructing the reasoning later.

`docs/PLAN.md` is the global plan. Do not dilute it with the details of a single
change; a single change goes in `specs/`, and the corresponding section of
`PLAN.md` is updated afterwards when it needs to be.

`docs/design/` is the archive of the 74 records written before Spec Kit
(`YYYY-MM-DD-topic.md`). It is read-only: nothing new is added there, and
nothing in it is renamed or reformatted, because the source cites those paths
by name and `pnpm test` checks that every citation still resolves. Read them —
they are the reasoning behind the code — but a new change writes to `specs/`.
