# Peek Constitution

This file is what `/speckit-plan`'s Constitution Check measures a plan against.
It lists the decisions that are already made and the rules every change obeys.
It does not restate the reasoning — each entry cites the section of
`docs/PLAN.md` or the record under `docs/design/` that holds it. If an entry
here and its citation disagree, the citation wins and this file is wrong.

## Core Principles

### I. One command channel

Every state change is a Command on the Command Bus in the main process. A
human clicking, the embedded agent, an external MCP client and workspace
restore all enter through the same channel; nothing writes workspace state by
another route. A plan that adds a second write path — a component holding its
own copy of layout state, an IPC channel that mutates state directly, a
library that keeps its own model — violates this principle.
(`docs/PLAN.md` §1, §6, §10 "Tiled layout: build in-house".)

### II. Four processes, fixed roles

Renderer, main, one driver host per connection, one package host per package.
The renderer renders and sends intent; main holds the Workspace Store, the
Command Bus, the Connection Manager and the MCP server; driver hosts talk to
databases; package hosts are launched lazily. A plan does not move a
responsibility across that boundary without saying so in its Constitution
Check. (`docs/PLAN.md` §3.)

### III. Capabilities, not a lowest common denominator

A driver declares a capability set and the UI and MCP tools adapt to it.
Whether a collection can be sorted, browsed or searched is the driver's
declaration, not a table in core. One `LogicalType` maps to exactly one JS
representation. (`docs/PLAN.md` §4, §10 "the driver declares it per
collection", "exactly one".)

### IV. The performance budget is a hard limit

Cold start < 1.5s; first result chunk < 100ms overhead; 1M-row scrolling at
60fps with nothing materialised whole; ~200MB renderer result cache with LRU
eviction; adaptive chunks; an ack window for backpressure. Numbers are
measured, not estimated, and §8.1 records how. A plan whose change touches a
budgeted path says which line of the table it affects and how it will be
measured. (`docs/PLAN.md` §8, §8.1.)

### V. Writes are gated by decisions a human makes

Editing data is not in scope until the two open decisions in `docs/PLAN.md`
§10 "Still open" — what "Read-only, always" becomes, and whether an MCP client
may write — are settled by the user. A plan does not settle them on its own.
The audit trail (`commands.jsonl`, visible in the UI) is already decided and
landed. (`docs/PLAN.md` §10 "Write operations".)

## Standing Decisions

Recorded so that a plan does not reopen them. Each is settled in
`docs/PLAN.md` §10 with its reasoning:

- The tiled layout is built in-house.
- Connections are persisted; credentials go through the OS keychain.
- Layout and open views are persisted as `ViewOpenSpec`, never session state.
- The MCP port is configurable and scans forward on conflict.
- Failure attribution records the initiator on the thing being created
  (`origin`), never by correlating logs.
- Not doing, deliberately: startup-time optimisation, per-driver bundle
  splitting, changing the driver registry type, screen-reader verification
  and LICENSE selection on the user's behalf.

## Repository Rules

- **English in the repository, Chinese in conversation.** Code, comments,
  commit messages, every Markdown file. `pnpm test` fails on Han characters
  outside blockquotes, code fences and inline code.
  (`docs/design/2026-08-29-the-documentation-goes-english.md`.)
- **`pnpm test` is the gate**: prettier, the vocabulary check, the docs
  check, then every package's tests. A change is not done while it fails.
- **Conventional Commits with a lowercase scope**, written by the user's own
  rules (`development-rules` skill). No `Co-Authored-By` trailer.
- **The old word is gone.** The mechanism is called a *database package*;
  `scripts/check-package-vocabulary.mjs` enforces the allowlist.
  (`docs/design/2026-08-07-database-packages-from-disk.md` §0.1.)

## Process

- **Documents before code.** A change that touches behaviour, structure or
  interaction has a `spec.md` and a `plan.md` under `specs/NNN-short-name/`
  before `/speckit-implement` runs. Typos, formatting and version bumps are
  exempt. (`CLAUDE.md`.)
- **A conflict stops the work.** When the Constitution Check, or anything
  else, finds that what is asked contradicts a decision recorded here or in
  `docs/PLAN.md`, list the conflict for the user — what was decided, what is
  asked, where they fail to line up — and wait. Do not pick a side.
- **`plan.md` carries Trade-offs and Verification** (the override template
  adds them). A plan without the approaches it rejected is not finished.
- **`docs/design/` is read-only history.** 74 records, cited by 224 source
  comments. Nothing new goes there; nothing there is renamed. A new change
  cites them and writes to `specs/`.
- **`docs/PLAN.md` is updated after** a change that alters the global
  picture — a settled question, a new milestone, a measured number — and is
  never diluted with a single change's details.

## Governance

This constitution is amended by a change of its own — a `specs/` entry whose
plan says what is being added or reversed and why — and the version below
moves with it. A reversal is struck through and dated, never deleted, the same
way `docs/PLAN.md` §10 records its own reversals.

**Version**: 1.0.0 | **Ratified**: 2026-09-11 | **Last Amended**: 2026-09-11
