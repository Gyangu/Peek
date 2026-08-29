# Peek — working conventions

## Every change goes through the documents

Any change that touches behaviour, structure or interaction goes **through the
documents before it goes into the code**. The document stays in the repository
and is committed alongside the code, as the decision record for that change.

The order is fixed:

1. **Look for conflicts** — before starting, read the existing design documents
   (`docs/PLAN.md` and the relevant records under `docs/design/`) and establish
   whether what is being asked conflicts with what is already designed.
2. **A conflict is settled first** — list the conflict explicitly for the user:
   what the documents decided, what is being asked now, and where the two fail
   to line up. **Stop and wait for the user to say which side wins.** Do not
   pick one and carry on.
3. **Update the documents once it is settled** — revise the design record to the
   agreed conclusion (edit the old one, or write a new one) so that the
   documents are the single source of truth again.
4. **Then implement against the documents** — the code follows the updated
   record. If the design turns out not to work during implementation, go back to
   step 2 and settle it again; do not let the code and the documents quietly
   diverge.

Design documents:

- Location: `docs/design/`
- Naming: `YYYY-MM-DD-<lowercase-hyphenated-topic>.md`, for example
  `2026-08-01-chat-session-management.md`
- **Language: English.** Documents in this repository are written in English.
  The reason is that the repository is open source and the source comments were
  always English — 221 comments point at `docs/design/`, and the documents have
  to follow so that readers do not hit a language wall between a citation and
  its target. This includes design records: as of 2026-08-29 the Chinese ones
  have been translated, reversing the 2026-08-24 rule that said they would not
  be. Translating a decision record is allowed; rewriting one is not — claims,
  dates, measurements and struck-through reversals survive a translation
  unchanged. Conversation with the user stays in Chinese; this rule governs only
  what is written into the repository.
- Cover at least:
  1. **What this fixes** — the current state, the problem, and the boundary of
     this change (say explicitly what it does not do)
  2. **The plan** — what changes, which files and modules it touches, the data
     structures and how state flows
  3. **Trade-offs** — the other approaches considered, and why they lost
  4. **Verification** — how to confirm the change is right (manual steps or
     tests)

Exception: changes with no design space in them — plain typo fixes, formatting,
dependency version bumps — need no document. When in doubt, write one; a short
document beats reconstructing the reasoning later.

`docs/PLAN.md` is the global plan. Do not dilute it with the details of a single
change; a single change goes in `docs/design/`, and the corresponding section of
`PLAN.md` is updated afterwards when it needs to be.
