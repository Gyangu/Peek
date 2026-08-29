# The starting permission: read once, or read every time

## 1. What this fixes

### Where things stand

Settings → Chat agent → "Which permission new conversations start in" writes
`agent.permissionMode` into `settings.json`, and
`2026-08-03-pluggable-agent-backends.md` §3.6 calls it "set once, then forgotten,
and quietly applied to **every conversation from then on**".

It is not. After changing it, newly opened conversations still use the old value
until peek is restarted.

The path:

```
main/index.ts:1121   const chosen = settingsStore?.read().agent      ← read once at startup
main/index.ts:1144   if (chosen?.permissionMode) acpConfig.permissionMode = chosen.permissionMode
acp/manager.ts:1167  setSessionMode({ …, modeId: this.#config.permissionMode })
```

`wireChatHost` is called exactly once, at `index.ts:941`, and nothing reassembles
it afterwards. The endpoint variant has the same shape: `wireEndpointBackend`
does `permissionMode: chosen.permissionMode ?? 'default'`, which is that same
snapshot.

**The interface has never said so.** `settings.agent.restartHint` ("takes effect
the next time peek starts. Existing conversations keep the agent they were
created with — the two store their history in different places and cannot read
each other's.") hangs off the **backend** row. That reasoning is true, and it is
true **only of the backend**: the backend holds live sessions, and swapping it
means handing the records to something that cannot read them. A permission mode
is not that kind of thing — it is one value, used once per session creation. A
setting that needs no restart hitched a ride on a read that does, and the
explanation was written for a different row.

### The second symptom: display

`buildChatViewState` (`bus/handlers/chat.ts:1072`) hard-codes
`permissionMode: 'default'`, and all four "new conversation" entry points
(`Panel.tsx:222`, `StatusBar.tsx:345`, `FirstRunGuide.tsx:131`,
`ChatSessionsRail.tsx:271`) pass no such field. So a new conversation's dropdown
initially reads "ask me every time", always.

It does get corrected — `#applyPermissionMode` `#patch`es the real value back once
the session exists — but **sessions are created lazily**: there is no session
until the first message goes out. Which means the dropdown is wrong for as long
as the user has not spoken; and if `setSessionMode` fails (which raises only a
warning toast), it is wrong **forever**.

To the user those two symptoms are one thing: they set it, they cannot see it,
and it did not take effect.

### Found along the way: a hand-off that was never honoured

`watchChatViews` puts `permissionMode: view.permissionMode` into the
`session.open` `ChatEffect` (`chat.ts:1022`). **Neither backend reads it.** The
`session.open` branches at `chat-host.ts:285` and `:504` look only at
`resumeSessionId`.

A field that is filled in, passed along, and never read is one a reader takes for
the path that works — which is exactly how the first pass of this diagnosis went
astray.

### Boundary (not done here)

- **The backend's "takes effect on next start" does not change.** Its reasoning
  is true, and `restartHint` stays as it is.
- **The panel's own permission dropdown does not change.** Switching per
  conversation, temporarily, is untouched.
- **Existing conversations do not change.** Each carries its own mode, and the
  setting only decides where a new conversation starts — §3.6's own words.
- **The set of available modes does not change.** Four remain four, and the
  validation in `settings.ts` is untouched.
- **The chat host is not reassembled.** Changing backend still needs a restart;
  this only makes one value read live.

## 2. The plan

### 2.1 Replace the value with a way of getting the value

`AcpHostConfig.permissionMode` changes from `ChatPermissionMode` to
`() => ChatPermissionMode`, and `EndpointHostConfig` likewise. Assembly passes a
closure that reads `settingsStore`:

```ts
permissionMode: () => settingsStore?.read().agent?.permissionMode ?? 'default'
```

It is evaluated when a session is created, so "the next new conversation" gets
whatever is in the file at that moment.

**This is not a new shape in this config.** `AcpHostConfig.resolveCwd` is already
a `() => string`, and its comment says why: evaluating at assembly time lets one
optional panel's failure take the whole application down with it. Different
reason, same shape — "this value is not known until the moment it is used".

### 2.2 The display uses the same evaluation

At `session.open`, the chat host patches that view's `permissionMode` to
`config.permissionMode()`. One evaluation, two uses: patched to the interface,
and sent to the agent when creating the session.

So a new conversation's dropdown is correct from the instant it appears, without
waiting for a first message and without depending on `setSessionMode` succeeding.

**Not through the reducer.** `buildChatViewState` runs inside `produce`, and
`ReduceCtx` carries only `source` / `commandId` / `now` / `ids` / `plan` /
`prepared` — no settings, and it should not have any: adding a field that only one
kind of view cares about would make every command carry it. `prepared` is wrong
too — its contract is "main has to go and ask another process", and this is
reading an in-memory store.

`buildChatViewState`'s `'default'` is therefore **kept**, with its meaning demoted
from "a new conversation's permission" to "a placeholder until somebody says
otherwise". It is still the strictest mode, and that does not change.

### 2.3 Delete the dead parameter

`ChatEffect`'s `session.open` no longer carries `permissionMode`. It was never
read, and its presence leads the next person to believe the setting travels along
that path.

### 2.4 Files involved

| file | what changes |
|---|---|
| `main/acp/types.ts` | `AcpHostConfig.permissionMode` becomes a thunk |
| `main/acp/manager.ts` | the evaluation becomes `this.#config.permissionMode()`; `defaultAcpConfig`'s constant default becomes a thunk |
| `main/agent/endpoint/loop.ts` | `EndpointHostConfig.permissionMode`, as above |
| `main/index.ts` | both assemblies pass a closure reading `settingsStore` |
| `main/chat-host.ts` | both `session.open` branches: patch the view's mode |
| `main/bus/handlers/chat.ts` | `ChatEffect.session.open` drops `permissionMode`; `watchChatViews` stops filling it |
| `main/acp/__tests__/*.test.ts` | the fixtures' `permissionMode` becomes a thunk |

### 2.5 Data flow

Settings written to disk → (nothing is pushed) → evaluated at the next
`session.open` → the interface is patched and `setSessionMode` is sent.

No notification, no subscription, no invalidation. That is the entire reason for
choosing a thunk over a setter; see §3.

## 3. Trade-offs

**A setter was considered: `manager.setPermissionMode(mode)`, pushed once after
`settings.write` lands.** Rejected. Pushing needs somebody responsible for
pushing, and "who forgot to push" is the name of a whole class of bug — this very
bug is in that family, "read once at assembly and never read again". A thunk has
no timing: the moment it is read is the moment it is used.

**Changing only the copy was considered** (adding "takes effect on next start" to
the permission mode row too). Five minutes, and honest. Rejected, because it
freezes a fixable mechanical problem into an explanation — and this setting should
work the way its documentation already says it does.

**Having a new conversation's view read the setting in the reducer was
considered** (a field on `ReduceCtx`, or going through `prepared`). Reasoning in
§2.2: a value only one kind of view cares about does not belong in every command's
context.

**Making the backend read live along the way was considered.** Explicitly not
done. The backend holds live sessions and a child process, and swapping it is a
reassembly rather than a re-evaluation — `restartHint` is telling the truth.

**Two layers of `?? 'default'` are kept** (one in the closure, one in
`buildChatViewState`). It looks redundant and is not: the first means "the
settings file did not say", and the second means "nobody has told this view yet".
Two different unknowns whose answers happen to coincide.

## 4. Verification

### Automated

Two cases added to `acp/__tests__/manager.test.ts`, one per half:

**"The starting permission is read when the conversation starts, not at
assembly".** One manager, two `send`s, with the thunk's return value changed in
between; assert that the two `session/set_mode` messages actually sent over the
protocol are `['default', 'plan']`. The observation point is **on the wire**
rather than inside the object holding the setting, following the sandbox test
beside it.

This one was verified in the inverse — make the evaluation happen once per process
(the old behaviour) and the test goes red immediately, reporting exactly
`["default","default"]`, which is this bug's actual symptom; restored, it goes
green. **The old structure could not express this test**: the value lived in the
config, and the test had no way to change it midway.

**"Setting a mode on a conversation with no session yet moves the dropdown and
sends nothing".** This is the contract the display half depends on: a new
conversation creates no session until somebody speaks, and the chat host now calls
it the moment the view appears. Both assertions are present: the patch arrived
(otherwise the dropdown keeps lying), and the log file does not exist (otherwise
every user who opens a panel and never types pays for an agent start).

**`chat-host.ts`'s wiring has no unit test**, stated plainly here: that layer needs
a real manager, a store and the effect loop all present at once, and the repository
has no test infrastructure for that layer today (`main/__tests__/` holds only the
hardening file). The second case above tests the behaviour it depends on, not its
wiring; the wiring falls to step 2 of the manual verification.

The rest:

- typecheck passes after `permissionMode` is removed from `ChatEffect`, which is
  itself the proof that nobody read it.
- `pnpm --filter @peek/desktop typecheck` — passes.
- `test` — 1,855 passing, 0 failing (1,853 before).
- `build` — passes, including both audits and `render-probe`.

### By hand

1. In settings, change the starting permission from "ask me every time" to "plan
   only", **without restarting**.
2. Open a new conversation → the dropdown should read "plan only" immediately
   (before the change it read "ask me every time").
3. Send a message that triggers a tool call → the behaviour should be plan mode's
   (before the change it was default mode's).
4. Go back to settings, change it to "ask me every time", **without restarting**,
   and open another new conversation → the dropdown reads "ask me every time".
5. The conversation opened in step 2 is **unaffected** — the setting only decides
   where a new conversation starts.
6. Switch one conversation to a different mode temporarily in the panel → only
   that one is affected, and the setting does not change.
7. Repeat 1–4 for the endpoint backend.
8. Change backend → still requires a restart, and `restartHint` is still telling
   the truth.
