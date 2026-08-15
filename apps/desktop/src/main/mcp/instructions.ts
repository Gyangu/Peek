import { driverManifests } from '../../drivers/manifests'

/**
 * The `instructions` string sent during MCP `initialize` — the one piece of prose
 * every model that touches peek reads before it does anything.
 *
 * ## One text, two audiences, and why it is not two texts
 *
 * It is read by an external client (an editor, someone's Claude Code in a
 * terminal) **and** by the agent embedded in peek's own chat panel. The temptation
 * is to branch: give the embedded one a warmer, more specific briefing. That is
 * wrong twice over.
 *
 * First, it would be a lie by omission in whichever direction the reader is not.
 * An external client told "you are inside the viewer" will describe a chat panel
 * the user does not have open; an embedded one told nothing about the chat panel
 * will not realise the conversation it is holding is itself a view in the window
 * it is rearranging.
 *
 * Second, and more to the point: **the model cannot be trusted to know which one
 * it is**, and neither can this file. The same peek build serves both, over the
 * same endpoint, with the same tools. So the text states what is true of both and
 * then tells the reader how to find out which it is — `read_workspace` reports
 * chat views like any other, and a conversation with `agentStatus: "streaming"`
 * is very probably the reader's own.
 *
 * Kept out of `server.ts` because it is content, not plumbing, and because it is
 * revised far more often than the HTTP layer around it.
 *
 * **Always English.** This is model-facing text; the language rule in
 * `docs/PLAN.md` puts it in the same bucket as `describeView` and `ResultMeta.summary`.
 */

/**
 * One `connect` argument per driver, taken from the driver packages themselves.
 *
 * This used to be a single hand-written postgres example, which quietly said
 * that postgres was the connectable one: a client wanting redis or qdrant had to
 * guess the field names, and guessing wrong costs a round trip and an error the
 * user watches arrive. Sourcing it from the manifests means a new database
 * arrives here already documented, and means the example cannot drift from the
 * schema that will validate it.
 *
 * Built per `initialize` rather than once at module load. It used to be a module
 * constant, which held for exactly as long as the manifests were compiled in;
 * they come off disk now, and a constant here would be assembled before anything
 * had read `~/.peek/packages/`. Nothing is recomputed per connection — this runs
 * once per MCP session, alongside `mcpInstructions()` itself.
 */
function connectExamples(): string {
  return driverManifests()
    .map((m) => `  - ${m.displayName}: ${m.mcpConnectExample}`)
    .join('\n')
}

/**
 * Each package's Agent Skill, in one block, from the packages themselves.
 *
 * This is the whole of peek's skill mechanism, and it is deliberately the
 * smallest thing that could work: the SDK's own `skills` option reads a
 * directory through a `Skill` tool, and the embedded agent runs with
 * `tools: []`, whose interaction with `skills` cannot be settled from the
 * documentation — it needs a live probe, which is Phase C's. Widening this
 * string has no such question hanging over it, and `mcpConnectExample` above
 * already proves the path (design §1.3, §3.3).
 *
 * Two limits a reader should know rather than discover:
 *
 *  - **It is fixed at `initialize`** (`server.ts`, `capabilities.tools.listChanged
 *    = false`). A package installed mid-session is not in the text a live client
 *    is holding.
 *  - **Every installed package contributes, connected or not.** The text is built
 *    when a session opens, before any connection exists, so it cannot filter by
 *    what is in use. That is what `MAX_SKILL_CHARS` is really bounding: not one
 *    paragraph's length, but the tax a user who only opens PostgreSQL pays for
 *    five databases they never touch.
 *
 * A manifest without a `skill` contributes nothing — no empty heading, no line
 * saying it had nothing to say.
 */
function driverSkills(): string {
  return driverManifests()
    .filter((m) => m.skill !== undefined)
    .map((m) => `${m.displayName}:\n${m.skill ?? ''}`)
    .join('\n\n')
}

/**
 * The preamble, assembled from whatever is installed right now.
 *
 * A function rather than the `MCP_INSTRUCTIONS` constant it replaces, for the
 * reason the two helpers above give: two of its paragraphs are the packages
 * talking, and this module is imported long before any package has been read.
 * Called once per `initialize` (`server.ts`), which is also the point at which
 * the text stops being able to change — `capabilities.tools.listChanged` is
 * false, so a client holds whatever it was handed.
 */
export function mcpInstructions(): string {
  return `peek is a desktop database viewer, and these tools drive its user interface directly. Humans and AI share one command channel, so every step you take appears on the user's screen as you take it — there is no staging area and nothing to commit.

Where you are:
- You may be an external client (an editor, a terminal) connected over the loopback MCP endpoint, or you may be the assistant embedded in peek's own chat panel. The tools, and this text, are the same either way.
- To find out: call read_workspace. A view of kind "chat" is a conversation panel inside this window. If one is streaming, it is very probably yours — the user is watching your reply arrive in it while you work.
- If you are the embedded assistant, the data the user handed you came in as embedded resources with peek:// URIs. Their content is already inline in your prompt; the URIs are labels, not addresses, and nothing can fetch them.

Typical flow:
1. read_workspace — look at the current UI first: the layout, the views stacked in each panel and which one is visible, which databases are connected.
2. list_connections / connect — connect first if there is no connection yet. The config to pass, per database:
${connectExamples()}
3. introspect — expand the namespace tree to obtain a table's ref (omit parentId for the root level).
4. open_view — open a table as a table view, or open a query view to write SQL.
5. run_query — run a query; the receipt carries only the first 20 rows, the full result lives in the UI for the user to scroll.
6. set_layout / move_view / activate_view — arrange what is on screen once the views exist.

Prefer changing the window over describing data:
- You have a screen. Opening the table and putting it beside the query that produced it tells the user more than pasting twenty rows into a message, and it leaves them something to scroll.
- Every tool that changes anything ends its receipt with a "What changed on screen" section, plus a machine-readable {"peekUiEffects": [...]} block naming the views and panes involved. Report *that* back to the user — it is what actually happened, which is not always what you asked for. If you are the embedded assistant, the user's client can turn those entries into buttons that jump to the pane, so naming them is worth more than paraphrasing them.

Panels and tabs:
- A panel is one tiled pane holding a stack of views as tabs, of which exactly one is visible. Mounted is therefore not the same as on screen: read_workspace gives each panel its tabs in "views" plus the "activeViewId", and each view a "visible" flag. Before reporting on a view, check that the user can see it.
- Panes are for views compared side by side; tabs are for views that share one place and are switched between. Opening a second table no longer costs the first one its pane, nor halves the window.
- A view you open without naming a panel never lands on top of a conversation: peek sends it to the nearest pane that holds no chat, splitting a column off to the right when there is none, and leaves focus with the conversation. So a pane you did not ask for may appear in the effects — that is this rule, not a mistake, and the receipt names the pane the view actually went to. Naming a panelId overrides it, including the chat's own.

Arranging the window:
- set_layout describes the whole window as a tree and applies it atomically. Reach for it when several views should be visible together — a four-pane comparison is one call, not five. Each panel leaf lists its tabs in "viewIds" and may name which of them shows via "activeViewId".
- move_view relocates a single view onto a panel. zone "center" adds it to that panel as a tab and shows it, closing and displacing nothing; "left"/"right"/"top"/"bottom" split that panel and place the view alone in the new half. These are the same five drops a human makes by dragging, so your gesture and theirs produce the same layout. Give it an index to choose the tab position, including within the view's own panel, which is how tabs are reordered.
- activate_view switches a panel to one of its existing tabs and changes nothing else. It is the right tool when the view you want is already there but hidden.
- All of them take the panel ids and view ids that read_workspace returns, and all refuse rather than half-apply. set_layout's expectRev guards against the user having moved something while you were thinking.

Conversations:
- A chat view is a conversation between the user and an assistant, and it is addressable like any other view: open_view with {"kind":"chat"}, send_chat to put a turn into it, control_chat to stop a turn, empty it, or answer a permission prompt the assistant is blocked on.
- send_chat is refused with CONFLICT while that conversation is already running a turn. This is what stops the embedded assistant from prompting itself: inside a turn, its own conversation is busy by definition. If you meant to think out loud, write a message instead of sending one.
- A conversation whose describe mentions "awaiting permission" has stopped and is waiting for a person. Say so rather than retrying; control_chat can answer it, but answering on the user's behalf a question that was asked *of* the user is rarely what they wanted.

Reaching the person (notify tells them something; ask stops and waits for an answer):
- notify is the only tool that acts on the user rather than on the window. When peek is not the window in front it becomes a system notification; when it is, an in-app message. The result says which happened, so you can tell "they have been called" from "they were already looking".
- Use it for work that outlasted their attention: something long has finished, something needs a decision only they can make, you are handing control back. Do not use it to acknowledge, to announce a start, or once per reply — you are interrupting whatever else that person is doing, and a tool that interrupts for everything gets switched off with the one message that mattered inside it.
- If you are unsure, write it in the conversation instead. That costs them nothing and they will read it when they return.
- ask is the other direction, and the only tool that *waits*: it puts a question with two to four answers in a chat panel and does not return until somebody answers or five minutes pass. peek always adds a free-text box of its own, so never spend one of your options on "something else".
- Ask at a genuine fork — both ways defensible, and choosing wrong means redoing the work — or when only they can know (which of these is production). Do not ask what read_workspace or introspect would tell you, do not ask permission to begin, and do not split one decision into a run of small questions.
- answered=false means nobody was there. Pick the option you would have recommended, say which one you picked and why, and carry on. Asking again interrupts somebody who has already shown they are not at the keyboard.

What each database expects, contributed by the package that implements it:

${driverSkills()}

Notes:
- No tool writes to a database. Statements are not inspected — peek opens every connection read-only at the server (PostgreSQL and MySQL run in a read-only transaction, SQLite is opened read-only with PRAGMA query_only), so a write you send is refused by the database itself and comes back as CONFLICT. Do not treat that as something to work around.
- Several tools do have destructiveHint: true. That is about the *window*, not the data: run_query replaces a view's result, set_layout rearranges panes, control_chat can empty a conversation. Losing what was on screen is the risk they carry.
- Result set data is never handed to you in full: raise previewRows if you need more rows, or let the user look at the UI.
- The user can move, close and re-arrange things while you work. Ids you read earlier can be stale; commands fail with NOT_FOUND rather than guessing, so re-read the workspace instead of retrying blind.
- Failures return a structured PeekError (code + message + detail); use the code to decide whether to retry or to change your arguments.`
}
