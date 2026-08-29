# Opening up the chat panel's capabilities: four switches, one position

> 2026-08-15. The user's decision: **fewer occasions where a person has to step in
> the middle**. All four actions selected; see §1.1.
> This document overturns one exclusion in `2026-08-03-pluggable-agent-backends.md`
> §3.6, and demotes the isolation of
> `2026-08-02-agent-source-and-permission-scope.md` §2.2 from a **mechanism** to
> **one explicit decision by the user**. The demotion is deliberate; the reasoning
> is in §2.5.

## 1. What this fixes

### 1.1 Four things the user keeps doing by hand

The question asked was "which actions do you keep doing by hand and want the agent
to take over", and all four were selected:

| action | why a person has to do it today |
|---|---|
| clicking "allow" over and over | every new conversation needs the permission mode switched again in the dropdown — the settings cannot hold those two modes |
| copying context across to it | the agent has no file-reading tool at all, and cannot see the schemas, migration scripts or documents in the project |
| it cannot change anything itself | no `Edit` / `Write` / `Bash`, so even writing a migration means a person carrying it to a terminal |
| existing MCP tools are unusable | `mcpServers: {}` cleared the inheritance, so not one of the user's own servers is visible in the panel |

### 1.2 The framing: this is not more power for the agent, it is fewer occasions for a person to be the middleman

Two of the first three are **not permission problems at all, they are missing
capabilities** — the person standing there is a porter, not a decision-maker. Only
the first is a permission problem, and its answer is already in the code, blocked
by one exclusion.

That distinction determines this document's shape: **a missing capability is fixed
with a switch, an interrupted permission is fixed with a default**, done
separately. Do not reach for "turn on the tools" to solve "clicking allow too many
times".

### 1.3 Boundary

**Done:** four switches (the default permission mode, the built-in tools, the
working directory, self-configured MCP), managed in the settings panel, plus a
third sandbox level and how it is expressed in the UI.

**Not done:**

- No per-tool switches (Read on, Bash off). See §4.2.
- `PermissionBroker` and the permission gate itself are untouched. The switches
  change **what the agent may request**, not how a request is handled.
- The source split (`source: 'agent' | 'mcp'`) is untouched in implementation;
  only what is **claimed** about it changes (§2.5).
- The endpoint backend's tool set is untouched. Its tools come straight from the
  MCP registry, no file tool exists in that process, and "turn on the built-in
  tools" is meaningless there; self-configured MCP servers need their own design
  for the endpoint backend, and this document does not do it.
- The sidebar's `agentWrites` switch is untouched. It governs peek's own driver
  path and is orthogonal to this document (though §2.4 records that it can be
  gone around).

---

## 2. Conflicts with the existing design

Four. The first three have a conclusion; the fourth is bookkeeping.

### 2.1 Conflict A — the settings cannot hold `dontAsk` (overturned; conclusion: the exclusion is lifted)

`packages/core/src/commands.ts:1402`:

```ts
export const AGENT_DEFAULT_PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'plan'] as const
```

`dontAsk` and `bypassPermissions` are excluded, with the reasoning in the comment
above it:

> The panel is where you say "just this once, I know what I am doing";
> `settings.json` is not. As a persisted default it is **set once, then
> forgotten**, and quietly applied to every conversation from then on.

**That argument is not wrong, but it refused something the user explicitly wants
on the user's behalf.** The user's own words were "fewer actions where a person is
in the middle" — "set it once and forget it" is the effect they are after, not the
failure mode they are guarding against.

**Conclusion: lift the exclusion, and `AGENT_DEFAULT_PERMISSION_MODES` becomes the
full set of `CHAT_PERMISSION_MODES`.** But what that comment worried about is
handled another way: not by forbidding it, but by **keeping it visible at all
times**. When the panel's permission dropdown is on a mode inherited from the
settings, it is marked as inherited rather than as this conversation's own choice.
The antidote to "forgot it was on" is visibility, not prohibition — the same
judgement `2026-08-14-agent-write-switch.md` §2.6 made about the write switch,
which also ended on "a permanent marker on the row" rather than "you may not turn
it on".

### 2.2 Conflict B — `tools: []` and `sandbox: 'enforced'` (conclusion: a switch plus a third level)

Three things are welded into the Claude Code profile in `main/acp/profiles.ts`:

```ts
const CLAUDE_TOOL_PRESET: readonly string[] = []          // every built-in tool disabled
export const CLAUDE_DISALLOWED_TOOLS = ['Bash', 'Read', 'Edit', ...]  // and disabled again, explicitly
buildSessionMeta: () => ({ claudeCode: { options: { settingSources: [], tools: [], disallowedTools: [...], mcpServers: {} } } })
```

What `sandbox: 'enforced'` means (from `AcpSandbox`'s doc comment) is "peek has a
probe, running against the real agent, checking that the restriction genuinely
takes effect", and that probe is `scripts/verify-chat-security.mjs`.

**Conclusions:**

1. `CLAUDE_TOOL_PRESET` and `CLAUDE_DISALLOWED_TOOLS` change from constants into
   two shapes generated by `buildSessionMeta` from the user's configuration. With
   the switch off the object is **byte-identical to today's** — that is the form
   the guarantee takes.
2. `AcpSandbox` gains a third level, `relaxed`. It is not "unverified" (which is
   Codex's situation: peek claimed something it never checked) but **"the user
   turned it off explicitly"** — an entirely different thing, and it cannot share
   `unverified`.
3. `profileById`'s "a bad id always falls to the `enforced` level" is unchanged: a
   bad value in the configuration still falls to the strict side, and only an
   explicit switch relaxes it.

### 2.3 Conflict C — `mcpServers: {}` and `settingSources: []` (conclusion: only the former opens)

These two are written together today, but **they guard against different things**,
and this document has to separate them.

The comment in `session-config.ts` records a measurement: without
`settingSources: []`, a panel whose dropdown reads "ask every time" could see
`mcp__postgres__execute_sql` directly — arbitrary SQL, ungated by peek.

But the cause of that leak is **wholesale inheritance**: whatever happens to be on
the user's machine is in the panel, with the user never having made a choice for
this panel at all. What the user wants this time is **an explicit list**: I pick
these three servers, and they come in.

| | inherited (`settingSources`) | explicitly listed (peek's own list) |
|---|---|---|
| who decided | nobody; whatever happens to be there | the user, adding them one at a time in peek's settings |
| across machines | different on every machine | travels with `settings.json` |
| revocable | by editing Claude Code's configuration | by deleting a line in the settings |

**Conclusion: `settingSources: []` does not change, and is kept permanently.** That
the peek panel behaves identically on every machine is not something this document
gives up — it is the precondition for "the permission dialog says what it means".
The MCP servers the user wants go through peek's own list, merged into
`mcpServers`.

That distinction is the same line M8 drew for packages (the closing paragraph of
PLAN §1): what is forbidden is "something that happens to be there taking effect
automatically", and what is permitted is "a thing the person installed themselves".

### 2.4 Conflict D — a self-configured MCP goes around the `agentWrites` switch (recorded, not fixed)

`2026-08-14-agent-write-switch.md` makes write permission a per-connection switch,
landing where main computes `allowWrite` and passes it to the driver. **A postgres
MCP server the user configured themselves does not travel that path** — it connects
itself and issues its own statements, and the sidebar switch constrains it in no
way at all.

**Not fixed.** The means of fixing it — parsing the SQL somebody else's MCP server
sends — is exactly the unwinnable game `2026-08-14` §1.1 describes. This is the
same species as the entry recorded in that document's §3.4:

> For peek's own five packages, the agent write switch is backed by the server. For
> an arbitrary third-party package, it is a convention.

One sentence is added now: **for a user's self-configured MCP server it is not even
a convention — that server does not know peek has such a switch.** This goes into
README's trust section.

### 2.5 The position: that token bypass, given up in the open

The isolation `2026-08-02-agent-source-and-permission-scope.md` established: the
main token lives in `~/.peek/mcp.json` (plaintext, 0600), `agentToken` lives only
in memory, so the embedded agent's calls are judged `source: 'agent'`, and
`chat.respondPermission` refuses that source outright — an agent may not press
"allow" on a person's behalf.

The first row of that document's §2.2 evidence table is explicit: the Claude Code
backend's evidence is **`tools: []` — it has no tool that can read a file**.

Turn the switch on and that evidence is gone:

```
Read / Bash  →  ~/.peek/mcp.json  →  the main token  →  source: 'mcp'  →  answer_permission ✓
```

**Conclusion: do not harden it; give it up in the open.** Three reasons:

1. **Under the user's premise it is not a threat.** What the user wants is for the
   agent to ask less and carry on. "The agent approving itself" and "a person
   choosing don't-ask-me in the dropdown" reach the same result. The difference is
   only whether the person knows what they turned on, which is a visibility
   problem, and §2.1 has already applied the same measure to it.
2. **Every available hardening is a bad trade.** Turning `answer_permission` off
   would destroy the external operator capability PLAN §7 states; taking the main
   token out of a plaintext file means changing README and every external client's
   way of connecting, and `Bash` could still find the trail elsewhere. Paying that
   for a guarantee the user is deliberately giving up is the wrong direction.
3. **peek has made this trade once before.** M8's decision 6: a package's entry
   point performs no checks, whatever is installed runs, and the settings panel
   carries one sentence saying what installing a package means, with no confirmation
   dialog. This document extends that same trade to the chat panel.

The cost is written in two places, not hidden: a `trustNote` beside the switch
(copying the shape of the one in package management), and one more entry in
README's "Packages and trust" section. **A row must be added to `2026-08-02`'s §2.2
evidence table**, stating what the Claude Code backend's evidence is once the switch
is on — and the answer is "there is none, the user gave it up", which is exactly
the sentence that should be written down.

---

## 3. The plan

### 3.1 Four switches, one place to configure them

`PeekAgentSettings` gains:

```ts
export interface PeekAgentSettings {
  // …existing fields
  /** See §3.2. The type widens from AgentDefaultPermissionMode to ChatPermissionMode. */
  permissionMode?: ChatPermissionMode
  /** See §3.3. Absent = false = today's behaviour. */
  acpFullTools?: boolean
  /** See §3.4. A new conversation's default working directory; each conversation may still choose its own. */
  defaultWorkdir?: string
  /** See §3.5. The MCP servers the user listed. */
  mcpServers?: AgentMcpServerSettings[]
}
```

All four fields are **today's behaviour when absent**. A `settings.json` with no
`agent` section must produce a `_meta` and a cwd byte-identical to today's — that
is what §3.6's first verification pins.

### 3.2 The default permission mode: the subset restriction is lifted

`AGENT_DEFAULT_PERMISSION_MODES` is deleted and
`AgentSettingsSchema.permissionMode` switches to `ChatPermissionModeSchema`. The
comment at `commands.ts:1362` is rewritten: it no longer explains why modes are
excluded, and instead explains **why it may be set, and what keeps it from being
forgotten** (pointing at the panel's inheritance marker).

On the panel side: `ChatView`'s permission dropdown marks the control when the
current mode is inherited from the settings and is not `default`. **This is the one
thing in this document a person cannot turn off** — the switch can be turned off,
the marker cannot, because the marker is what lifting the exclusion was traded
for.

### 3.3 The built-in tools: one switch, two `_meta`

`AcpAgentProfile.buildSessionMeta`'s `AcpAgentUserConfig` parameter gains
`fullTools: boolean`. The Claude Code profile:

```ts
buildSessionMeta: (config) => ({
  claudeCode: {
    options: {
      // Kept permanently, see §2.3. No switch affects this line.
      settingSources: [],
      // Switch off: [] plus the full disallowedTools (today's object, unchanged)
      // Switch on: no tools (the SDK's full default set) and no disallowedTools
      ...(config.fullTools ? {} : { tools: [], disallowedTools: [...CLAUDE_DISALLOWED_TOOLS] }),
      mcpServers: buildUserMcpServers(config),   // §3.5
    },
  },
}),
```

The `CLAUDE_DISALLOWED_TOOLS` constant is **kept as it is, not deleted**. Its
comment today calls it "the statement of intent a reviewer will grep for" — with
the switch off it is still that statement, and with the switch on it is that
statement's **inverse list**, rendered directly in the UI as "here is what you are
handing over". One list, two uses.

The Codex backend: its sandbox lives in the `INITIAL_AGENT_MODE` environment
variable. With the switch on it becomes `agent` (Codex's own writable mode), and
**`agent-full-access` is not offered** — that one grants the network and arbitrary
paths, beyond anything this document asks for.

The `sandbox` field changes from a static property of the profile into
`(config) => AcpSandbox`:

| configuration | level | what the UI says |
|---|---|---|
| Claude Code, switch off | `enforced` | nothing (this is the default, and the probe verified it) |
| Claude Code, switch on | `relaxed` | states plainly what was handed over, listing `CLAUDE_DISALLOWED_TOOLS` |
| Codex, any | `unverified` | today's copy, unchanged |
| Codex, switch on | `relaxed` | says both |

**`relaxed` disables no permission mode.** The rule that `unverified` forbids the
automatic modes (`2026-08-03` §3.6) does not extend to `relaxed` — that rule's
reasoning is "an agent peek cannot vouch for should not also be unwatched", and
`relaxed` is watched, and explicitly decided, by the user. Different premise,
different conclusion.

### 3.4 The working directory: each session chooses its own

Today `ensureChatWorkdir(configDir, agentId)` pins the cwd at
`~/.peek/chat[/<agentId>]`, and the comment's reasoning is "keeps the agent's
filesystem reach off the user's home directory" — which costs nothing while there
are no file tools, and becomes "Edit inside an empty directory" once there are.

**The change:**

1. `SessionRoute` gains `cwd?: string`. Absent (existing sessions, and new sessions
   with no directory chosen) = today's algorithm.
2. A directory may be chosen when starting a new conversation. `defaultWorkdir` in
   the settings is that choice's initial value, not an override.
3. `session/load` uses `route.cwd` when restoring a session.

**The `listSessions({ cwd })` path breaks, and this document's first draft said it
would not — that sentence was wrong, and it took implementing it to find out.**

The draft said "since `2026-08-03` §3.5 the conversation list reads an index and no
longer depends on enumerating by cwd". Reading the code shows otherwise:
`listSessions` in `chat-host.ts` **still enumerates from the agent side**, and the
index only labels each row with an agent's name (what that document's §3.5 changed
is who routes, not who enumerates). And `session/list` answers for one cwd at a
time. Built as drafted, conversations a user created in a project directory would
**disappear** from the rail.

**The correction: ask once per directory peek has a record of, with the filtering
graded to match.**

```
directories to ask = { the default cwd } ∪ { every route.cwd for this agent in the index }
```

The filter can no longer be "equal to where peek runs", because a user's project
directory is full of records from agents they ran themselves:

| directory | what is kept | why |
|---|---|---|
| peek's own workdir | everything | everything there is peek's. This is also what keeps conversations created before the index existed in the list |
| a directory the user chose | only session ids with a route in the index | that is the user's directory, and peek's conversations are mixed in with their own work |

This incidentally fixes an existing weakness: the old filter was "cwd is equal", so
if a user had ever run an agent inside `~/.peek/chat` themselves, those sessions
would blend into the list. Filtering by "does peek have a record of it" does not
have that problem.

A directory that cannot be reached (renamed, an unmounted volume) is logged as one
warning and skipped, rather than letting one directory take the whole listing down
— the ones that can answer are still worth listing, and the one that cannot will
speak for itself when it is opened.

**`workdirSegment`'s assumption that each agent has its own directory, invisible to
the others, now covers only the default directory.** Two agents pointed at the same
project directory will see each other's session files. **This is not a bug** (the
user chose the same directory twice), but the passage of the profile comment that
explains it has to change, or it describes an invariant that no longer holds
generally.

Each row in the rail has to show its cwd (the last path segment is enough, with the
full path in a tooltip). The reasoning is §2.1's, again: for a conversation that
can change files, **where** it changes them has to stay visible.

### 3.5 Self-configured MCP servers

A new type, in `packages/core`:

```ts
export const AgentMcpServerSchema = z.object({
  /** A name for a person to read, and also the tool prefix: mcp__<name>__* */
  name: z.string().regex(/^[a-z0-9_-]+$/),
  /** The transport. Only these two in the first version; reasoning in §4.3. */
  transport: z.enum(['http', 'stdio']),
  /** http: the endpoint URL. stdio: the path to an executable. */
  target: z.string(),
  /** stdio only. */
  args: z.array(z.string()).optional(),
  /** http only. See "a credential is one header" below. */
  authHeader: z.string().optional(),
  authValue: z.string().optional(),
  enabled: z.boolean(),
})
```

**They travel through `session/new`'s `mcpServers` parameter, not through Claude
Code's `_meta` (changed from the draft).** The draft said "translate them into
Claude Code's `mcpServers` object". The implementation goes through the ACP
protocol's own parameter, for three reasons:

1. `_meta.claudeCode.options.mcpServers` stays `{}`, and its meaning is still
   **clear out whatever happens to be configured on this machine**. The agent merges
   `{...options.mcpServers, ...params.mcpServers}`, so what the parameter sends
   arrives alongside peek's own, while the inherited side stays empty — which is the
   mechanism §2.3's whole distinction rests on.
2. Codex needs no second code path.
3. peek's own goes through the parameter already, so the two have the same shape.

**The merge direction is fixed**: peek's own always wins. A user-configured server
also named `peek` is **discarded with a warning** rather than renamed — a server
renamed to `peek-2` is one the user can never find again. The reason is not "a
collision needs a winner": behind `mcp__peek__*` sit the permission gate, the
command log and `source: 'agent'` attribution, and a second server of the same name
is not two servers fighting, it is the audit record describing the wrong thing.

**A credential is one header, not an array of headers (changed from the draft).**
The array's generality buys nothing: every value in it is a secret, each needing
sealing, a "set" marker and never being echoed back, and the form would grow a
nested editor. Nearly every HTTP MCP server authenticates with one header
(`Authorization: Bearer …` or `X-API-Key`), so peek takes a header name plus one
sealed value, and **the scheme is the user's to write into the value** — peek
prepending `Bearer ` would break every server that does not want it.

The credential follows the existing pattern for the endpoint backend's apiKey
(sealed by `SecretVault` and stored as `authValueSealed`), and is registered in
`#rememberSecret`'s redaction table at the moment it is handed to the agent.

### 3.6 The settings panel

`AgentSection.tsx` gains two blocks:

- **Capabilities**: one switch, "let the agent use file and command tools". With it
  on, a `trustNote` expands beneath it listing the contents of
  `CLAUDE_DISALLOWED_TOOLS` and stating §2.5's sentence plainly — the permission
  prompt is no longer a gate. **No confirmation dialog** (following the shape of
  M8's package install).
- **MCP servers**: a list that can be added to and removed from, each row carrying
  name / transport / target / an enable switch. A "test connection" button,
  following the shape of the endpoint backend's.

The default working directory is a directory picker beneath the capabilities
block (it only means anything with the switch on, but it is not hidden — a hidden
setting is a setting nobody can find).

---

## 4. Trade-offs

### 4.1 Why there is no "safe middle ground"

Three were considered and all abandoned:

- **Give Read but not Write or Bash.** It stops nothing: `Read ~/.peek/mcp.json`
  is the whole of §2.5's chain. Giving Read is giving everything, and the middle
  ground is fictional.
- **Keep `~/.peek` outside the agent's reach.** Claude Code's `Read` takes an
  absolute path, and peek has no hook that can intercept it. Genuinely blocking it
  needs an OS-level sandbox, which is engineering of another order.
- **Issue the chat panel a third, read-only token.** The main token still lies on
  disk where the agent can read it, and a third token is one more identity that
  removes no capability.

All three point at the same conclusion: **this guarantee is either whole or absent,
and there is no middle ground.** So say which one is being chosen.

### 4.2 Why there are no per-tool switches

"Read on, Bash off" looks like finer control and is in fact worse: it gives a
person the feeling of making a choice, while by §4.1's first item any tool that can
touch the filesystem takes the guarantee to zero. An option that does not change
the outcome should not appear in the settings — its only effect is to make somebody
believe they are still protected.

### 4.3 Why the MCP transports are http and stdio only

These two cover the overwhelming majority of existing servers, and are the two both
Claude Code and Codex recognise. SSE's support state differs between them, and the
first version does not touch it.

### 4.4 Why lifting the default permission mode is not "remember the last one chosen"

That is a third semantics (neither a setting nor a decision for this conversation),
and it would make what the dropdown shows even less traceable. A setting is a
setting: visible, changeable, and marked.

### 4.5 Why the endpoint backend does not follow

The endpoint backend takes its tools' handlers straight from the MCP registry, and
no implementation of a file tool exists in that process — "turn on the built-in
tools" is not something a switch can do there, and genuinely giving it filesystem
capability means implementing those tools first. Self-configured MCP servers *are*
feasible for the endpoint backend (one more source in `endpoint/tools.ts`), but it
would have to maintain the MCP client connections itself, which is an entirely
different path from the ACP backend's "hand the descriptor to the agent". Both are
left for later; all four of this document's requirements hold on the ACP backend.

---

## 5. Verification

**Automatic:**

1. **Equivalence when absent**: with an empty `agent` configuration,
   `buildSessionMeta()`'s return value is deeply equal to today's object and
   `ensureChatWorkdir()`'s path is unchanged. **This is the case that should be
   written first** — it is the executable form of "with the switch off, nothing
   changed".
2. **The switch's two states**: with `fullTools: true` the `_meta` contains neither
   `tools` nor `disallowedTools`, and `settingSources` **is still `[]`** (§2.3's
   never-opened line).
3. **Sandbox levels**: all four combinations (two profiles × the switch's two
   states) compute the right level; `relaxed` restricts no permission mode, and
   `unverified` still does.
4. **The permission mode**: a `dontAsk` in `settings.json` is read and takes
   effect; the panel's dropdown marks it as inherited.
5. **The MCP list**: entries with a name collision, illegal characters or a missing
   field are skipped and reported while the rest still take effect; a
   user-configured `peek` does not displace peek's own descriptor; secrets in
   headers appear in no log (hanging off `redact.ts`'s existing tests).
6. **cwd routing**: `session/load` uses `route.cwd` when present and falls back to
   today's algorithm when not; an existing `sessions.json` (without the field)
   opens normally.
7. **`verify-chat-security.mjs` has to change, and how needs thinking through.** It
   asserts "zero tool calls" today, and with the switch on that assertion
   necessarily goes red. **This is not a relaxation, it is another dimension**:
   - under the default configuration the assertions are unchanged (zero tool calls,
     only `mcp__peek__*` seen) — this is §5.1's end-to-end form;
   - with the switch on it asserts **something else**: that `settingSources: []` is
     still in effect (the panel has not inherited the user's `CLAUDE.md` and
     permission rules), and that the UI really does display `relaxed`'s
     explanation.
   The probe changes from "verifying an absolute guarantee" to "verifying the
   default, and that the truth was told when it was given up". That change itself
   goes into the script's header comment — it is this document's most important
   change to that file.

**By hand:**

8. With the switch on, have the agent read a schema file in a real project and
   write a query from it, confirming the porterage in §1.1's second row is genuinely
   gone.
9. Configure one of your own MCP servers (any one), and confirm its tools appear as
   `mcp__<name>__*` and that peek's own tools have not been displaced.
10. Set the default permission mode to `dontAsk` in the settings, open three new
    conversations, and confirm all three stop asking and all three dropdowns are
    marked "from settings".
11. **With the switch on, have the agent read `~/.peek/mcp.json`.** It will succeed
    — that is not a bug, it is §2.5's decision. This case is run to confirm **that
    the explanation is on the UI after it succeeds**, not to confirm that it fails.

---

## 6. Implementation plan

Five steps, each a change that stands on its own as a commit, with the tests green
at the end of each.

**Step 1 — the guardrail for equivalence when absent.** Write §5.1's test first,
pinning today's `_meta` and cwd. None of the four steps that follow may turn it
red.

*Result:* done, as the first case in `acp/__tests__/profiles.test.ts`. A whole
`deepEqual` rather than field by field, pinning Codex's `env` along with everything
else. The test says in so many words: when this goes red, the problem is never how
to update the expected value.

**Step 2 — lifting the permission mode exclusion.** Delete
`AGENT_DEFAULT_PERMISSION_MODES`, widen the schema, rewrite the comment, and add
the inheritance marker to the panel's dropdown. The smallest of the four, and the
only one needing no new switch.

*Result:* done. `AGENT_DEFAULT_PERMISSION_MODES` was not deleted but **pointed at
`CHAT_PERMISSION_MODES`** — that name is still the name of the concept "modes that
may serve as a default", and only the answer became "all of them"; deleting it
would change every reference to a name that no longer states its purpose.

The inheritance marker is `ChatViewState.permissionModeInherited`, **not** a
comparison of the current value against the setting. Comparison would describe a
value the user chose by hand as "inherited", which is a different statement about
provenance. `chat.setMode` clears it even when the mode did not change: somebody
just made a decision for this conversation.

Six missing i18n entries were added (labels and explanations for the two new
modes), and `modeDangerNote`'s "these two modes are not offered here" no longer
holds and now explains the marker mechanism instead.

**Step 3 — the built-in tools switch and the `relaxed` level.** A field on
`AcpAgentUserConfig`, `buildSessionMeta` in two states, `sandbox` becoming a
function, and the settings panel's switch and `trustNote`. Reworking
`verify-chat-security.mjs` happens in this step (§5.7).

*Result:* done. Three departures from this document's draft, all recorded here:

1. **`AgentProfileInfo` gained a `baseSandbox`.** §3.3's table requires "says both"
   for Codex with the switch on, but the renderer only receives one already-computed
   tier, and `relaxed` swallowed `unverified`. Sending "what it is with the switch
   off" as well lets the panel render the two sentences separately: the `relaxed`
   sentence follows the switch, the `unverified` sentence follows `baseSandbox` (so
   it is still there once the switch is on), and the `enforced` sentence appears
   only when the restriction genuinely takes effect.
2. **The switch is read at boot, not per conversation.** The opposite of
   `permissionMode`'s thunk, with the reason written into `index.ts`: Codex's
   sandbox switch is in the **process environment**, and a child process that has
   already started cannot change it.
3. **`agent-full-access` is unreachable at every level.** Codex's
   `INITIAL_AGENT_MODE` only moves between `read-only` and `agent`, with a test
   assertion pinning it — that mode removes the workspace boundary and the network
   restriction together, and nothing this document asks for needs it.

The probe was reworked per §5.7 and passes with `--offline`: section 1's eight
assertions are untouched (it passes `{}`, and has always tested the default
configuration), and a new section 1b tests "the switch took what it says it takes,
and did not take `settingSources` along the way". The script's header comment now
states that what it verifies has changed from "an absolute guarantee" to "the
default, and that the truth was told when it was given up", and explains that when
an assertion goes red, "the sandbox is broken" and "the user turned the sandbox
off" are two different things — and that this script never reads the user's
settings, so what it reports can only be the former.

**Step 4 — a working directory per session.** `SessionRoute.cwd`, choosing a
directory when starting a conversation, showing it in the rail, and correcting the
`workdirSegment` passage in `profiles.ts`.

*Result:* done, including one documentation correction (§3.4's `listSessions`,
where the draft had the fact backwards). Four things worth recording:

1. **The directory picker was renamed, not duplicated.** `IPC.PACKAGES_PICK_DIR` →
   `IPC.PICK_DIR`, `pickPackageDir()` → `pickDirectory()`. It never had anything to
   do with packages — it takes no argument and knows nothing about what happens
   next; it is `showOpenDialog({ properties: ['openDirectory'] })`. A second channel
   would have been the same eleven lines under a different name.
2. **Clearing uses `null`, not an empty string.** `settings.ts`'s merge layer
   already has a "forget it" convention (`endpointApiKeySealed`), and `agentWorkdir`
   follows it rather than inventing a second. The form sends an empty string and
   `handlers.ts` translates it to `null` — a cleared input **is** an empty string,
   and making the window speak the file's dialect draws the boundary in the wrong
   place.
3. **A chosen directory is not created, given a profile section, or had its
   permissions changed.** `ensureChatWorkdir` only calls `mkdirSync` when peek owns
   the directory itself. A renamed chosen directory is "the setting is wrong", to be
   reported, not "there is a hole", to be filled — because one mistyped letter would
   otherwise conjure `~/Projcts/api` out of nothing and have the agent work
   somewhere the user has never seen.
4. **`record()`'s missing field was caught on the spot by a test.** It constructs
   field by field rather than spreading (which is right: that file's entire
   discipline is "store routes only, and nothing resembling a transcript"), at the
   cost of one more line there for every field added — and the `cwd` line was
   missing the first time. That is written down in a comment.

The working directory is a thunk (the settings are read for each new conversation),
the opposite of `acpFullTools`, with the reason written into `index.ts`: cwd is a
parameter of `session/new` for both agents, while the sandbox switch is in the
`_meta` for one and the process environment for the other, and the latter cannot be
changed for a child process that has already started.

The rail shows the directory only when it is **not the default** (the last path
segment, with the full path in a tooltip). Nobody reads a label that is identical
on every row. Found along the way: `session.agent` (the backend name `2026-08-03`
§3.5 said should be shown) **has never been rendered** — chat-host has always sent
it and the rail has never drawn it. This document does not fix it in passing;
it is recorded here.

**Step 5 — self-configured MCP servers.** The new type, `buildUserMcpServers`,
credentials into the vault, the settings panel's list, and validation at load time.

*Result:* done. Two departures from the draft are already written into §3.5 (the
ACP parameter rather than Claude's `_meta`; one header rather than an array of
headers). Three more:

1. **The list is replaced whole, not merged member by member.** The same reasoning
   as `keybindings`: member-wise merging can only add, and "I deleted this server"
   cannot be expressed at all. The form always holds every row, so the file cannot
   lose a row the sender still has.
2. **A credential that was not resent has to survive.** The form has never held the
   credential (it is write-only), so a save that only changes the URL naturally
   carries no credential. Reading that as "clear it" would quietly break a working
   server, and the fault would surface much later as "authentication failed", which
   nobody would connect to a URL change. Main matches against the stored one by
   name: field absent = keep, empty string = clear.
3. **A fake vault must produce ciphertext that does not contain the plaintext.**
   The assertion is `file.includes(secret) === false`, and a fake seal written as
   `sealed(<value>)` **contains the plaintext verbatim** — the assertion would go
   red against a perfectly correct implementation, and the easiest way to make it
   green would be to weaken the assertion. Reversing the string is what lets the
   assertion say what it means to say.

This block appears in the settings panel **for the ACP backend only**. The endpoint
backend's tools are function handles taken straight from the MCP registry, with no
client to point at a server, so it would be a form that stores something and does
nothing (§4.5).

**Step 6 — closing the documents.** *Result:* done, all six landed. One stale
sentence in PLAN §1 was corrected along the way ("all four still hold today" — the
fourth was voided by `2026-08-14`, whose own closing was left unfinished; §10's
"write operations" section is still the old one and is **left to that document**,
with this one only annotating §1).

- PLAN.md: §1's non-goals passage about "who made the decision" has to take in the
  chat panel as well (today it covers only packages); the technology row for "the
  embedded agent" gains a sentence saying its capabilities are configurable.
- `2026-08-02-agent-source-and-permission-scope.md` §2.2's evidence table gains a
  row: with the switch on, the Claude Code backend has no evidence, and the user
  gave it up.
- `2026-08-03-pluggable-agent-backends.md` §3.6: annotated as overturned by this
  document's §2.1.
- `2026-08-14-agent-write-switch.md` §3.4: one sentence added, that for a
  self-configured MCP server it is not even a convention (§2.4).
- README: the several `Read-only, always` places were already changed by
  `2026-08-14`; what changes here is the trust section, gaining two entries — what
  the built-in tools switch means, and that a self-configured MCP server is not
  bound by the write switch.

**Prerequisites:** step 1 is the precondition for everything else. Steps 2, 3, 4 and
5 do not depend on one another and may run in parallel or in any order, though
landing 4 before 3 buys little (choosing a directory is an empty gesture with no
file tools).
