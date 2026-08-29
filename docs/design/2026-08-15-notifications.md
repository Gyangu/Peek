# Notifications: letting the agent call you when you are not watching

## 1. What this fixes

### 1.1 What is here today

Peek has toasts and no notifications. Elsewhere the two words are used
interchangeably; here they are two different things:

| | the existing toast | the notification this wants |
|---|---|---|
| outlet | `IPC.NOTIFY` → `Toasts.tsx`, bottom right | the macOS Notification Centre |
| precondition | the window is in front, with somebody looking at it | none |
| who sends it | a failed command, a driver crash, driver stderr | **the agent's own decision** |
| lifetime | info disappears after 4.5 seconds | it stays in the Notification Centre until it is cleared |

The header comment on `renderer/state/notifyStore.ts` places the toast exactly:
"purely transient renderer UI state". It is right — and precisely because it is
right, a toast cannot carry what this change asks for. A message that disappears
after 4.5 seconds, drawn only in the bottom-right corner of a window that may be
minimised, **has not happened at all the moment the user switches away** — and
"the user switched away" is the only situation that needs a notification.

### 1.2 There are two gaps, not one

**The first is the outlet**: zero `new Notification` in the repository, zero dock
badge, zero bounce. Peek has never had a message channel that can get out of the
window.

**The second is the vocabulary**: MCP's thirteen kernel tools
(`main/mcp/tools/`) can open a view, run a query, read state, send a chat
message, drive another chat — **not one of the verbs is "tell that person
something"**. Neither is one of the thirty-six entries in `COMMAND_NAMES`.

The two gaps point in opposite directions, which is worth saying separately: the
first is a capability Peek lacks; the second is a deliberate silence in Peek's
design — the AI can only change the interface, and once it has, it **counts on
the person happening to be looking**. PLAN §6's "Human and AI actions go through
the same command channel, so the state is always consistent" guarantees that the
state is consistent; it does not guarantee anyone knows the state changed. When
an agent turn that ran for forty seconds ends, what Peek does today is: draw the
reply into a panel nobody may be watching, and go quiet.

### 1.3 Boundary

Doing:

- one outlet that can get out of the window (the main process's Electron
  `Notification`);
- one MCP tool, `notify`, so the agent can call for the person itself;
- an automatic notification when an agent turn ends (and when it is stuck waiting
  for permission);
- one settings switch for each of the two above.

Not doing (struck out explicitly, so it does not come back next round):

- **No notification centre / notification history.** The error centre
  (`renderer/components/error-center/`) already is that thing, and toasts already
  land in it — `errorLog.ts:121` records a toast with no error code as `NOTIFY`.
  Notifications leave their trace by the same route; a second list does not grow.
- **No long-query-finished notification.** Notifying when a hand-run query passes
  N seconds is a separate product line with nothing to do with the agent (it has
  to answer "how long is long", "does switching away and back count", "notify on
  a cancel?"). Not touched here.
- **No Windows / Linux-specific behaviour** (action buttons, reply, Toast XML).
  Electron's `Notification` comes out on all three platforms; anything beyond the
  intersection goes unused.
- **The web `Notification` in a package frame is not unblocked.** See §4.3.

## 2. The plan

### 2.1 One outlet, two deliveries

A new module `main/notifications.ts`, plus an eight-line
`main/notifications-electron.ts`.

**Why two files**: a module that imports `electron` cannot be loaded under plain
Node — and plain Node is what the tests run on, where `electron` resolves to a
*path string*, so a named import throws at resolution time, and it throws by
association: every test whose import chain touches it dies. That is exactly how
it happened — `bus/handlers/app.ts` wants `unavailableNotifier`, so half the
bus's tests went red together. The line in `config/handlers.ts` about importing
`connections/timeouts` directly rather than through the barrel, "otherwise these
handlers cannot be loaded in a plain-Node test", is the same discipline, applied
one level higher this time: **the decision table stays on the side that can be
tested, and only the thing that only Electron can do goes where only Electron
looks.**

`notifications.ts` is the **only** place that knows how a notification is
decided.

```ts
export interface UserNotice {
  level: NotifyLevel                      // info | warn | error, the existing three
  message: string                         // notification title / toast first line
  detail?: string                         // notification body / toast second line
  /** which view to bring to the front, besides focusing the window, when the notification is clicked */
  focusViewId?: ViewId
  /** what to do while the window is in front */
  whenFocused: 'toast' | 'nothing'
}
```

`createNotifier(deps)` returns a `notify(notice: UserNotice): void` whose logic is
two steps:

1. **The window is in front** → follow `whenFocused`: `'toast'` is the existing
   `sendNotify(renderers, …)`, not a line of it changes; `'nothing'` does nothing.
2. **The window is not in front** (`!isFocused() || isMinimized() ||
   !isVisible()`, any one of them) → `new Notification({ title, body }).show()`,
   **and at the same time** push the toast, so the person who switches back can
   still find this one in the error centre (`whenFocused: 'nothing'` pushes it
   too — what it refuses is being interrupted while in front, not the record).

**Why no system notification while the window is in front**: with the window in
front the toast is right there, and a banner as well is saying the same thing
twice; and what a macOS banner covers is the top-right corner of the screen — the
top-right corner of the window the user is looking at. A notification that blocks
your screen while you are staring at it is the fastest way for this feature to be
switched off.

**Click behaviour**: the `click` handler restores and focuses the window
(`restore()` + `show()` + `focus()`), and dispatches a `view.activate` if a
`focusViewId` came with it. This step reuses the three lines already written in
the `second-instance` handler (`index.ts:1412`); it does not reinvent "how to
call the window back".

### 2.2 `app.notify`: the 37th Command

```
app.notify   { message, detail?, level?, focusViewId? }
```

A new `app.*` namespace. Not one of the six existing namespaces (conn / view /
query / layout / chat / state / mcp / settings / packages) can hold it: it
changes no connection, no view, no layout, belongs to no chat, and is not a
preference read or write. It is **the application saying something to the user**.

It **does not change the Workspace**, so it bumps no rev and broadcasts no patch.
That does not make it an outlier in this table — `state.read`, `conn.book.list`,
`settings.read` and `packages.read` all change no Workspace, and what
`settings.write` changes is the disk. The Command Bus was never only a
state-change channel; it is an **intent channel**.

**Why go through a Command rather than giving the MCP tool an outlet straight to
the notifier**, three reasons, weakest first:

1. PLAN §6: "UI events and MCP tool calls converge on the same entry point". A
   notification is the most direct thing an agent can do to the user; there is no
   reason for it to be the exception that goes around the entry point.
2. `bus/command-log.ts` keeps the books for free. "Who interrupted this person,
   when, and with what" is exactly what an audit asks, and going through a
   Command means no second set of books has to be written for it.
3. **`ToolContext` does not have to move.** A tool that wants the notifier
   directly needs a new member on `ToolContext` — and `ToolContext` moved into
   `@peek/core` with the 2026-08-03 pluginisation, so a package's tools eat the
   same contract (see the `mcp/types.ts` header comment). Widening an interface
   every package has to honour, for the sake of one kernel tool, is completely
   out of proportion. Through a Command, the tool layer stays a thin shell and
   the contract does not change by a word.

The handler lands in a new file `app.ts` under `bus/handlers/`.

**This is where this document differs from its first draft, and the reason is
worth recording**. The draft said "register a `notify` EffectIntent, execute it
in `bus/effects.ts`", and that turned out not to work: **an intent's execution
result cannot get back to the handler**, and that result is precisely what this
command most needs to report — did the banner actually go out, or is the user
looking at Peek right now. An agent that cannot tell those two apart can only err
one way or the other: notify twice, or believe it spoke when it did not.

So it uses another shape the bus already has: **a `read` handler plus an injected
collaborator**, written exactly the way `createChatHandlers` /
`createConfigHandlers` are — `createAppHandlers(notifier)`. A `read` changes no
Workspace, bumps no rev and broadcasts no patch, but it still goes through the
zod gate and still enters the command log. `bus/handlers/index.ts` mounts
`unavailableAppHandlers` (the pre-assembly stand-in, which reports "nothing was
sent anywhere" rather than throwing), and `main/index.ts` overwrites it with the
real one during assembly.

The optional `CommandDeps.notify?.()` member stays as it is, untouched: it is
**the bus complaining about itself** (raising an alarm on a soft failure), and
**somebody asking for a notification** is a different thing; mixing them makes it
impossible to tell who is talking in the command log.

### 2.3 `notify`: the 14th kernel tool

`main/mcp/tools/notify.ts`, a `defineCommandTool` mapped onto `app.notify`.

Annotations: `readOnlyHint: false` (it has an external side effect),
`destructiveHint: false`, `idempotentHint: false` — **sending it twice is
interrupting twice**, which is not idempotent.

The description is the only real design work in this tool, because what decides
"when should I notify" is the model, not us. It has to make three things clear:

- **Do use it**: something long-running finished; something turned up that needs a
  person to decide; control is being handed back to the person.
- **Do not use it**: one notification per reply. A tool that notifies every time
  is switched off by the third day, and then it cannot get the one that mattered
  out either.
- **It is an interruption**: this message will show up in the user's Notification
  Centre, possibly while they are doing something else.

The tool name goes into `mcp/kernel-tool-names.ts` — that file has a test
(`kernel-tool-names.test.ts`) pinning it against the actual files under `tools/`,
so forgetting to add it is red, and nobody has to remember.

**The cost, written down here rather than pretended away**: a dozen or so
comments in the repository say "the kernel's thirteen" (`registry.ts`,
`executor.ts`, `package-tools.ts`, `loader.ts`, `core/mcp-tools.ts`,
`drivers/mcpTools.ts` and several tests). Adding a fourteenth tool expires all of
them. They are all corrected in this pass, with no "later" left over — a comment
whose number does not add up reads as "the code changed and nobody kept up with
the comments", and that reaction contaminates every accurate sentence next to it.

### 2.4 The end of an agent turn: hooked onto the one write point

`chat-host.ts`'s `createChatStateApplier` is the **only** write point for agent
state: both the ACP backend (`acp/manager.ts`) and the built-in endpoint backend
(`agent/endpoint/loop.ts`) come in through it, which is what the header comment's
"The only writer is the ACP host, in-process" means. So the automatic
notification only has to hook this one place, both backends get it at once, and a
third backend gets it automatically later.

The criterion is a **transition**, not a state value:

```
busy    = starting | streaming
resting = idle | ready
```

- `busy → resting`: a turn ended → notify, with `lastMessagePreview` as the body
  (that field is already in the patch, nothing new is computed).
- `busy → awaiting-permission`: **also notify**, with the tool's name as the body.
  See below.
- No other transition notifies. `loading → ready` in particular: that is the
  replay when a stored conversation is opened (`ChatAgentStatus`'s header comment
  explains at length why that state exists), not somebody waiting on you.

`whenFocused: 'nothing'`. While you are looking at the panel the reply is already
drawn in front of you, and at that moment any form of "it replied" is noise.

**`awaiting-permission` is one I added, and it deserves its own note**: what the
user asked for was "notify automatically when a turn ends", and strictly speaking
waiting for permission is not a turn ending. But it is the other half of the same
thing — **it is your move** — and it is the half that matters more: finding out
five minutes late that a turn ended costs you five minutes; finding out five
minutes late that it is stuck on a permission means the agent did not move an
inch for those five minutes. They share one switch, because the person who wants
only one of them has not turned up yet; split it when they do.

### 2.5 Settings

`~/.peek/settings.json` grows a third key:

```jsonc
{
  "notifications": {
    "system": true,        // master switch for system notifications. With it off the notify tool still succeeds, it just does not leave the window
    "agentTurnEnd": true   // notify automatically when a turn ends / when it is stuck waiting for permission
  }
}
```

The header comment on `config/settings.ts` set a bar for new keys: "the small set
of choices that would otherwise have to be made again on every launch". Both of
these clear it — "I do not want to be interrupted" and "I want it to call me" are
both long-lived facts about how this person works, not about this one session.

(Fixing one expired line along the way: "Two entries today" was written when
there were only two keys; today there are four.)

**With `system` off the `notify` tool still returns success**, the message just
lands as a toast only. This is deliberate: a tool call that fails because of a
user preference makes the model guess "did I use it wrong?" and retry. The tool's
receipt says where the message went, the model can read it, and the user's
preference survives.

In the UI, a new **NotificationsSection** (Settings → Notifications) with two
switches. Not folded into AgentSection: `system` is global and governs more than
the agent. Built from the form primitives established by
`2026-08-13-settings-form-primitives.md`; no hand-written controls.

## 3. Trade-offs

**Why not the renderer's web `Notification` API**. Three reasons, any one of them
enough: `window-hardening.ts:88`'s `setPermissionRequestHandler` refuses
everything, which would refuse it outright; it requires the window to be alive
and not unloaded; and the triggers for a notification (agent state transitions,
Commands) are all in main, so going out to the renderer to pop it means one more
hop and one more failure point. Main's `Notification` goes through no permission
handler at all.

**Why `notify` is not a read tool**. `defineReadTool` hardcodes `readOnly: true`,
and a notification has an external side effect — what it changes is not the
Workspace, it is **that person's attention**. Marking it read-only comes due
somewhere in the future at a "in read-only mode, only readOnly tools are allowed
through" — where a session claiming to be read-only could send the user
notifications, which is not what anyone reading that switch would expect.

**Why no "quiet hours" / do not disturb**. macOS has Focus modes of its own, and
does it better than we could. Peek's switch answers only "should Peek send this";
"should anything ring right now" is the operating system's question.

**Why the automatic notification defaults to on**. The user asked for it
explicitly. And its noise ceiling is low: it only comes out while the window is
not in front, at most one per turn.

**Known limitation: in dev mode the notification is signed "Electron"**. macOS
identifies an app for notifications by bundle id, and `pnpm dev` runs Electron's
own bundle. It is correct once packaged. Nothing is worked around for this —
changing the bundle id for the sake of dev-mode appearance trades the artifact's
correctness for how development looks.

**When `Notification.isSupported()` is false**: degrade silently to pushing a
toast only. No error, no prompt — a platform that does not support notifications
is not something the user did wrong.

## 4. Relationship to the existing design

### 4.1 PLAN §6's command table (36 → 37)

That section says "This table stays closed on purpose — a package cannot add
verbs to it … all the names are kernel-generic". `app.notify` does not shake
that: it is exactly kernel-generic (belonging to no database and no kind of
view), and **a package still cannot add verbs** — a package that wants to notify
the user can only call it the way it calls any other command. The table is
updated to 37.

### 4.2 PLAN §7's tool roster (13 → 14)

One category line is added to the roster:

```
- Notification: `notify`
```

and "a default install ends up at 13 + 1" becomes "14 + 1".

### 4.3 `2026-08-07-database-packages-from-disk.md` item 5

The original:

> **`setPermissionRequestHandler` refuses everything** — camera, microphone,
> **notifications**, clipboard, geolocation — Peek needs none of them.

After this change that sentence is literally untrue, but **not a word of what it
governs is loosened**: what is refused is **web code inside a package frame**
asking for the browser's `Notification` permission, and Peek's own notifications
are sent from the main process and never reach the permission handler at all. The
two are orthogonal.

That line is reworded to: a package frame needs none of them — when Peek itself
wants to notify the user it sends from main, not down this path. **This is not an
opening cut for packages**: a package's code that wants to notify the user has to
call `app.notify`, which puts it in the command log, signed with that package's
name.

### 4.4 Relationship to `2026-08-15-logging-and-audit.md`

That design is giving four existing log channels a common terminus. A
notification is not a log, and the two are not merged — but `app.notify` going
through the Command Bus means it shows up in the command log automatically, so
once that design lands, "when has the agent interrupted me" is answerable without
anything extra being done here.

## 5. Verification

**Unit tests** — `main/__tests__/notifications.test.ts`, 23 of them, all green.

| what it tests | how |
|---|---|
| no system notification while in front | fake window with `isFocused() → true`, assert zero banners and one toast |
| in the background it banners, and still leaves a trace | `isFocused() → false`, assert one banner + one toast |
| minimised / hidden also counts as "nobody there" | run both states, banner in each — `isFocused()` alone would miss them |
| no window at all counts as "nobody there" | a notification during startup still gets out |
| `whenFocused: 'nothing'` does nothing in front | assert zero calls on both outlets |
| `whenFocused: 'nothing'` still leaves a trace in the background | "do not interrupt me" is not "do not keep a record" |
| `system` switched off | zero banners, toast as usual, result reported honestly (not as an error) |
| `supported() → false` | as above, and it does not throw |
| the pre-assembly stand-in | `unavailableNotifier` reports "neither was sent", does not throw |
| clicking the banner calls Peek back | a window that is minimised + hidden + unfocused, assert all three of `restore → show → focus` |
| clicking the banner jumps to the named view | assert `view.activate` receives the id; with no id, nothing is touched |
| the command's thin shell | `app.notify` defaults level to `info`, holds `whenFocused` at `toast`, and passes optional members only when given |
| end of turn notifies only on a transition | `streaming → idle` gives one; `idle → idle` and `ready → ready` give zero |
| replay does not notify | `loading → ready` gives zero |
| waiting for permission notifies | `streaming → awaiting-permission` gives one, with the tool name |
| a failed turn does not notify | `streaming → error` gives zero (the panel and the error centre are already saying so) |
| a blank title is not spliced into the copy | `title: '   '` reads as no title |
| the wording on a lock screen | four combinations of title / no title / tool name / no tool name |
| the tool name is registered | the existing `kernel-tool-names.test.ts` covers it automatically (151 MCP tests all green) |
| the command table is closed | the existing `_assertNoMissingResult` / `coreHandlers satisfies Required<CommandHandlerMap>` cover it automatically |

**By hand**

1. Settings → Notifications: both switches are there, tick and untick, and they
   survive a restart.
2. In the chat panel, have the agent run something slow, switch to another app,
   wait for it to finish → a notification appears in the Notification Centre;
   click it → Peek comes back to the front.
3. The same thing with the window left in front → no system notification, and no
   toast either.
4. Have the agent call the `notify` tool ("use notify to tell me something") → a
   toast in front, a notification in the background.
5. Switch `system` off and repeat 2 and 4 → only the toast is left, and the tool's
   receipt says where the message went.
