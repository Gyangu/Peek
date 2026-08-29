# Making `source: 'agent'` real, and closing the permission scope leak

> 2026-08-02. Prompted by the control spec
> ([`2026-08-02-control-spec.md`](2026-08-02-control-spec.md) §2.6), which drew a
> DOM-level boundary for "an agent must not get at its own permission prompt", and
> then by somebody asking: **is that road really closed today?** It is not. It just
> does not go through the DOM — it goes through the bus.

---

## 1. What this fixes

### 1.1 There is an enum member the documentation states twice and nothing ever wired

`CommandSource` in `packages/core/src/commands.ts` has four members, and the comment
on `agent` reads:

> `agent` peek's own embedded chat panel driving the interface back through MCP.
> **The wiring is to give the embedded agent its own `createMcpServer` handle with
> `source: 'agent'`; without that it is indistinguishable from any MCP client — and
> that is the whole reason this enum member exists.**

`ToolContext` in `apps/desktop/src/main/mcp/types.ts` says it a second time: "peek's
own embedded chat panel has its own server handle, `source: 'agent'`".

What is actually the case:

- there is **exactly one** `createMcpServer` in the repository (`index.ts:472`), and
  it is **passed no `source`**;
- `mcp/server.ts:148` therefore falls through to `options.source ?? 'mcp'`;
- `buildPeekMcpServer` at `acp/session-config.ts:52` hands the embedded agent **the
  same URL and the same bearer token**.

So the value `agent` **has never been produced at runtime**. Both comments describe an
isolation that does not exist — written at a security-relevant spot. This is the most
typical of all the problems in this round: **a specification kept alive by comments is
a specification that diverges from reality**, and what diverged this time is "who is
operating".

### 1.2 The leak: an authorisation's scope goes from "this conversation" to "this window"

Start with what it is **not**, because the first version of this conclusion was wrong
and is worth keeping on the record.

It is not "one agent call can void the permission system". Every `mcp__peek__*` call
the embedded agent makes goes through `requestPermission` itself (`acp/manager.ts`,
`buildSessionMeta` in `acp/profiles.ts`), alongside the `settingSources: []` /
`tools: []` / `CLAUDE_DISALLOWED_TOOLS` sandbox. In the default mode it has to ask a
person about its own tool calls, never mind answering for someone else.

The real hole opens **once a permission mode has been turned on**:

1. A person picks `dontAsk` or `bypassPermissions` in conversation A's dropdown and
   gets past the confirmation dialog (`needsModeConfirmation`, legibility baseline
   §2.6).
2. From then on A's agent calls peek tools without being asked.
3. It calls `control_chat { viewId: B, action: 'answer_permission', optionId: 'allow' }`.
4. `mcp/tools/control-chat.ts` maps that to `chat.respondPermission`, and the reducer
   in `bus/handlers/chat.ts` checks whether the requestId is stale and whether the
   optionId is legal — **and looks at `ctx.source` alone not at all**.
5. The permission prompt conversation B was holding for a person to look at has been
   answered on their behalf.

What the person authorised was "**conversation A** need not ask me again"; what took
effect was "**this window**". `HUMAN_ONLY_MODES` (`chat.ts:117`) governs only **who may
set** a mode, not **how far the setting reaches**.

### 1.3 Why the renderer's boundary does not stop it

Control spec §2.6 puts `data-peek-exposure="human-only"` on PermissionPrompt's buttons
and guards it with a test. That boundary is not wrong in itself — it defends against the
**future** road where "MCP can click a button". But:

- the renderer is a read-only mirror (PLAN §3), and MCP does not go through it at all;
- a DOM attribute is invisible to main.

**The boundary belongs in the layer that holds the information.** "Who is calling" is
known only to main, so the rule has to live in main.

### 1.4 Boundary (explicitly not done this time)

1. **No "one identity per chat conversation".** All embedded conversations share one
   agent credential, so "is this the embedded agent" is distinguishable and "which one"
   is not. That is enough for the hole being closed here (see §3.1).
2. **No `HUMAN_ONLY_COMMANDS` table.** The reason is in §3.2 — it would void the
   external operator along with everything else, and that is a deliberate capability
   written down in `control-chat.ts:107` and PLAN §7.
3. **No change to the semantics of the permission modes.** `dontAsk` /
   `bypassPermissions` can still only be picked by a person in the interface.
4. **No change to exposure.** The DOM boundary control spec §2.6 reserved stays as it
   is; the two are rules in different layers. See §2.4.

---

## 2. The plan

### 2.1 A second credential, the same server

`createMcpServer` gains an optional `agentToken`:

```
external client ──── Bearer <token>       ──→ session source = 'mcp'
embedded agent  ──── Bearer <agentToken>  ──→ session source = 'agent'
```

- **The same port, the same path.** No second listener: two ports would mean writing
  two `mcp.json` files, running port probing twice, and explaining two addresses in
  the settings page — when the thing that needs distinguishing is the **credential**.
- **`source` moves from "one per server" to "one per session".** An MCP session is
  established at initialize, and that request carries the Authorization header, so
  "who is this session" is settled the moment the session is created and does not have
  to be recomputed per request.
- **agentToken lives only in memory and is never written to `~/.peek/mcp.json`.** This
  is what makes the isolation hold: an external client cannot obtain it.

### 2.2 Impersonation analysis (both directions have to be looked at)

**An external client impersonating `agent`?** It would need the agentToken, which never
reaches disk. And even with it, `agent`'s permissions are a **subset** of `mcp`'s —
impersonating it is a downgrade, not an escalation. No motive, no harm.

**The embedded agent impersonating `mcp`?** It would need the main token. It cannot get
it — but **what that rests on differs by backend**, and so does the strength (since
2026-08-03 the chat panel has three backend tiers):

| backend | what it rests on | strength |
| --- | --- | --- |
| Claude Code (ACP) | `_meta.claudeCode.options`: `tools: []`, `settingSources: []`, `CLAUDE_DISALLOWED_TOOLS` — it has no tool that can read a file | verified: `scripts/verify-chat-security.mjs` runs probes against a real agent |
| Codex (ACP) | the environment variable `INITIAL_AGENT_MODE=read-only` | **unverified**: the semantics line up, but there is no equivalent probe yet. The profile is marked `sandbox: 'unverified'` and the UI says so |
| user endpoint | an in-process loop; tools take their handler straight from the MCP registry and **do not go through the HTTP loopback**, so there is no agentToken to protect in the first place; nor does any file tool's implementation exist in that tool set | strongest: not "we ask the SDK to behave itself" but "the capability is absent" |
| **any ACP tier + the file-tools switch (since 2026-08-15)** | **Nothing.** The user explicitly turned it off | not applicable — see below |

This passage originally wrote only `tools: []`, because at the time Claude Code was the
only tier. The statement now is: the isolation still does not rest on "the agent will
behave", but **what it does rest on depends on which tier it is** — the table above
spells that out tier by tier, and the `unverified` tier does not pretend in the UI to
be verified. See `2026-08-03-pluggable-agent-backends.md` §2, conflict A.

**The last row is not a weaker basis; it is no basis.** After 2026-08-15 there is a
switch in settings which, once on, hands the ACP agent its own file and command tools —
so the first row's "it has no tool that can read a file" stops being true, and this
entire isolation is built on that sentence:

```
Read / Bash  →  ~/.peek/mcp.json (plain text, 0600)  →  main token  →  source: 'mcp'  →  answer_permission ✓
```

**peek does not defend against this; it reports it truthfully.** The profile's sandbox
level becomes `relaxed`, the settings panel says plainly what is being handed over, and
there is no confirmation dialog — the same bargain M8 made for packages. The reasoning,
and why all three hardening routes are not worth it, are in
`2026-08-15-chat-panel-full-capability.md` §2.5 and §4.1.

`verify-chat-security.mjs` changed what it verifies to match: **under the default
configuration the first three rows above all still hold and are all verified**, plus a
new section verifying "the truth was told when it was given up". That script never
reads the user's settings, so its going red can only mean "the sandbox broke", never
"the user turned the sandbox off".

### 2.3 Rule: `chat.respondPermission` refuses `source === 'agent'`

A one-line policy, standing alongside the `chat.setMode` one — the second place on the
bus where `source` affects an outcome.

**Why refuse outright rather than "refuse only across viewIds"**: all embedded
conversations share one credential, and `viewId` is an argument rather than an
identity, so the notion of "its own viewId" does not exist on the main side (§1.4, item
1). And refusing outright is semantically right anyway — `control_chat`'s own tool
description says:

> Answering a permission prompt is for an **operator driving peek from outside**; if a
> person is sitting at the window, the prompt is already in front of them and is theirs
> to answer.

The embedded agent is not an external operator, and a person is sitting at the window.
Its calling this action **has no legitimate use in any mode**, so the refusal need not
be tied to the mode — it refuses in `default` mode too, the only difference being that
there a person would still have seen a prompt first. The less a rule depends on state,
the harder it is to go around.

### 2.3bis Rule: `chat.answer` refuses `source === 'agent'` as well (added 2026-08-15)

The third place on the bus where `source` affects an outcome, added along with the
`ask` tool (`2026-08-15-agent-asks-a-question.md` §2.6). **This is not adding a row to a
table** — §3.2's reason for rejecting that table holds unchanged, so this is, like the
two above, a policy with its own reason written out.

The reason is harder than §2.3's. A permission prompt answered by the agent leaks one
**authorisation**; a question answered by the agent forges **a person's judgement**: the
user sees a decision that reads as "a person has been asked", when in fact nobody looked
at it from beginning to end, and every subsequent step the model takes is built on an
answer it wrote itself.

An external operator (`source: 'mcp'`) may still answer, for the same reason as §3.2,
item 1.

### 2.4 Relationship to control spec §2.6

Two rules, two layers, no overlap:

| layer | rule | guard |
|---|---|---|
| renderer / DOM | `data-peek-exposure="human-only"`, defending against the **future** "click a button" tool | `control-spec.test.ts` |
| main / Command Bus | `chat.respondPermission` refuses `source: 'agent'`, defending against **today's** bus path | the bus tests added this round |

Control spec §2.6 says "if MCP can one day click buttons, the first thing it must not be
able to click is Allow" — that sentence still stands; it simply had not been noticed at
the time that **the bus already carried a road to the same action**. What this document
adds is the "today" half.

### 2.5 Files involved

| file | change |
|---|---|
| `main/mcp/server.ts` | the `agentToken` option; `checkAuth` returns the identity it matched rather than a boolean; session-level `ToolContext` |
| `main/mcp/types.ts` | `ToolContext.source`'s comment goes from "this is how it will be" to fact |
| `main/index.ts` | mint the agentToken; `mcpEndpoint` (the one handed to ACP) uses it |
| `main/acp/profiles.ts` | one more sentence on the sandbox comment: it is now also the guarantee that the main token is unreachable (the sandbox itself has already moved here from `session-config.ts`, one per tier) |
| `main/bus/handlers/chat.ts` | the source policy on `chat.respondPermission` |
| `packages/core/src/error-messages.ts` | a new error key |
| `packages/core/src/commands.ts` | `CommandSource`'s `agent` comment: from "wire it this way" to "it is wired this way" |
| `renderer/i18n/messages/{en,zh-CN}/errors.ts` | translations for the new key |

---

## 3. Trade-offs

### 3.1 Why not "one credential per conversation"

That is the complete answer: it would distinguish **which** embedded agent, and could
therefore forbid only the cross-conversation case and let one answer its own. But the
cost is minting a credential for every chat conversation created, maintaining its
lifecycle, and rotating it when the agent restarts — and the benefit is "let the agent
answer its own permission prompts", a thing that **should not be allowed in the first
place** (§2.3). Paying for a credential-management system to buy a capability nobody
wants is the wrong direction.

### 3.2 Why not a `HUMAN_ONLY_COMMANDS` table

The first version of the plan was a table next to `commandSchemas` saying "these
commands may only be issued by `ui`", enforced uniformly by the bus. It has two
problems:

1. **It voids the external operator.** Embedded and external are both non-`ui` unless
   distinguished, so forbidding one forbids both. And `control_chat` answering a
   permission prompt is a capability PLAN §7 spells out ("an external client can watch
   and drive the embedded one"). Nor is there any benefit to putting the restriction on
   a token-holding external client: PLAN §7 equally says the token amounts to full
   control of the window and every connection in it.
2. **It disguises a policy as a table.** There are now two places on the bus where
   `source` affects an outcome, and each has its reason written out. A table invites
   whoever comes next to add rows, and each row is a policy decision made without an
   argument.

### 3.3 Why not intercept at the ACP layer

It looks closer to the scene: when the agent requests permission, peek knows which
conversation it is. But `dontAsk` / `bypassPermissions` are handed to the **agent
process** to enforce via `setSessionMode` (`manager.ts:938`), and in those two modes the
agent **never emits** `requestPermission` at all — peek has no hook to hang anything on.
That is exactly why the leak exists, and it shows the interception point has to be the
layer where peek itself receives the call.

### 3.4 Why not a second port

See §2.1. What needs distinguishing is the credential, not the endpoint, and a second
listener costs two `mcp.json` files, two rounds of port probing and the cost of
explaining two addresses in the settings page, in exchange for no isolation strength at
all — both are in the same process to begin with.

---

## 4. Verification

**Automated**:
1. New bus test: `chat.respondPermission` fails under `source: 'agent'` and succeeds
   under `'ui'` and `'mcp'`.
2. New server test: a session authenticated with the agentToken gets
   `source: 'agent'`, one with the main token gets `'mcp'`, and a wrong token is still
   a 401.
3. Assert the agentToken is **not** in `~/.peek/mcp.json` — the executable form of the
   isolation in §2.2.
4. No regression in the existing 1236 tests; `pnpm typecheck` passes for all six
   packages.

**Manual / for a person to do**:
5. Start two chat conversations, switch A to `dontAsk`, have A's agent try to answer
   B's permission prompt, and confirm it is refused with a legible reason. There is
   limited value in an agent doing this one — what it verifies is precisely "what an
   agent must not do".
