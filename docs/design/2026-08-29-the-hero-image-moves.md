# The hero image moves

> 2026-08-29. The README opens on a still of a tiled window. The one claim this
> project exists to make — that an AI arranges that window while you watch — is
> the one thing a still cannot carry. The hero becomes a recording.
>
> **§2.1 and §3 were reversed later the same day**, before anything was
> committed. The first cut recorded the window being driven by an MCP client with
> no agent in the picture, and §3 rejected recording a live Claude Code session.
> Watching the result made the mistake obvious: a recording of panes moving on
> their own does not show *who* moved them either. The hero is now a real
> session. The original argument is kept in §3 rather than deleted — it is why
> the cost of the reversal is understood rather than discovered later.

## 1. What this fixes

The first thing a visitor sees is `overview-{light,dark}.png`: three panes, a
tree, a table, a query that has returned. Everything in it is true. None of it
moves, and the sentence immediately above it reads *Claude drives the same window
you're looking at.*

| the claim, as the README states it | what the still shows |
| --- | --- |
| "Claude drives the same window you're looking at" | a window. Who arranged it is not in the frame |
| "every click and every MCP tool call is a Command on the same bus" | one end state, consistent with either party having produced it |
| "arrange panels for comparison — it happens in the window in front of you" | panels, arranged. Not *happening* |
| "an `ask` suspended until a person answers" | shown, further down, and it is the strongest image in the file |

A reader who takes the picture at face value has seen a database GUI. The
distinguishing feature is a *sequence* — a tool call arrives, the window changes,
the agent stops and waits for a human — and a sequence needs frames.

### 1.1 What the first cut got wrong

The first recording replaced the still with eight MCP tool calls issued by the
capture script: a tree opens, a grid takes a pane, a query runs, one `set_layout`
re-tiles everything, an `ask` suspends. Every frame was true and it fixed the
*sequence* problem in §1 completely.

It did not fix the attribution problem, and that is the one that matters. A
viewer sees panes appearing and has no way to tell an agent from a fast mouse.
The window moves; nothing on screen says why. Replacing "a window somebody
arranged" with "a window arranging itself" is a smaller step than it looked
while the choreography was being written.

What closes the gap is already built and was simply not in frame: the chat panel
renders the agent's tool calls **in plain language, as they happen**, and marks
peek's own tools as acting on this window (`renderer/components/chat/toolCalls.ts`
— a file that exists for exactly this reason: "a chat panel that renders it as
one more grey tool call row leaves the user watching their workspace rearrange
itself with no explanation"). With a real session in the right-hand pane, the
transcript is a running caption for the motion in the other three, written by the
product rather than by a caption track.

### 1.2 Boundary

- **Not replacing the other two pictures.** `agent-asks` keeps its place beside
  the chat-panel section: a suspended `ask` is the strongest single frame in the
  repository and it deserves a still a reader can stop and study. The `overview`
  still leaves the README and stays in `docs/images/`, because design documents
  link to it.
- **Not video, not audio, not narration overlays.** §3.
- **Not scripting what the agent says or does.** The script sets the scene and
  types one sentence. Everything after that is the model's, including the parts
  that are less flattering than a written demo would be.
- **Not touching the capture harness's contract.** `screenshot.mjs` keeps
  launching the built app on a throwaway port, config and user-data directory.

## 2. The approach

A fourth entry in `screenshot.mjs`, `agent-drives`, which differs from the three
stills in one respect: the shutter stays open while somebody else works.

### 2.1 What is recorded

A real conversation, in the window, with the model that ships as the chat panel's
default backend. The script's only role is to set the scene, type one sentence,
and hold the shutter open.

| beat | what the script does | what a viewer sees |
| --- | --- | --- |
| 1 | `connect`, `open_view{kind:'tree'}`, `open_view{kind:'chat'}`, `set_layout` | a namespace tree on the left, an empty conversation on the right — the window before anyone asks it for anything |
| 2 | `control_chat{action:'set_mode'}` | the conversation's permission mode, set once, in the open |
| 3 | `send_chat` | a request in plain English arrives as a user turn |
| 4 | *(nothing — the agent works)* | the transcript fills with named tool calls while the panes they name appear and rearrange beside it |
| 5 | *(nothing — the turn ends)* | the finished workspace, and a reply that says what was done |

Beat 4 is the whole point and it is the beat the script does not author. What the
agent chooses to call, in what order, with what wording, is the model's — which
is precisely why it is evidence. A sequence the capture script dictated would
prove no more than the still did.

**The prompt is fixed and committed** (`AGENT_PROMPT` in `screenshot.mjs`) so the
recording can be re-made and so a reader can see exactly what was asked. It asks
for work that is worth watching — two views, a query, a deliberate arrangement —
and it does not tell the agent which tools to use.

#### Permission mode

The chat panel ships on "Ask every time": every tool call stops and waits for a
person. That is the right default and the wrong recording — the hero would be a
person clicking Allow five times, which is the opposite of what it is there to
show.

The recording starts the conversation on **"Let the agent judge"** (`auto`). It
is a mode the product offers, its label is visible in the panel header for the
whole recording, and it is honest about what it does: the agent's own classifier
approves calls instead of the person, and the agent still cannot reach anything
beyond peek's own tools. The two modes below it in the list are marked with a
warning triangle for a reason and neither is used here.

It is set in the throwaway `settings.json` **before the app launches**, not
through `control_chat` afterwards, and that distinction was found the hard way.
A conversation's ACP session is created lazily — it does not exist until the
first message is sent — so a `set_mode` call issued before `send_chat` has
nothing to set, and the session is then born on the settings default regardless.
The first live take did exactly that and stopped four seconds in, blocked on a
permission prompt for `read_workspace`, with the conversation still reporting
`mode default`. `2026-08-13-permission-mode-takes-effect.md` §1 describes the
same lazy-session shape from the other end.

If a permission prompt appears anyway the run fails and says so, rather than
recording a window that has quietly stopped. That guard is not theoretical: it is
what turned the failure above into a one-line diagnosis instead of a recording
of a frozen window.

#### What is not deterministic, and what still is

The fixture is unchanged: the same deterministic LCG, the same ten tables, the
same numbers on screen. What varies is the agent's wording, its tool order, and
its latency. So the committed GIF is **one take**, chosen after watching several
— which is a weaker guarantee than the stills carry, and §3 is where that is
paid for.

Two things keep it from being arbitrary. The script logs every tool the agent
called, so the recording can be checked against a list rather than a memory. And
the run asserts the shape it needs before it writes anything: the turn must
finish, it must have called at least three of peek's own tools, and no permission
prompt may be left pending.

### 2.2 Capturing frames

`Page.captureScreenshot` on a fixed interval, with `clip.scale` doing the
downscale at capture time rather than in ffmpeg afterwards.

**Not `Page.startScreencast`.** It is the obvious choice and it is wrong here for
two reasons. It delivers frames as CDP *events*, and `cdp.mjs` deliberately
carries no event plumbing — it dispatches replies and drops everything else, a
narrowness its header calls out as the reason it needs no version pinning.
Widening it for one script would be paid for by the four other scripts that share
it. Second, a screencast only produces a frame when the compositor produces one,
so a deliberately still beat — the suspended `ask`, which is the most important
frame in the file — emits nothing and has to be reconstructed from timestamps
anyway.

Polling costs one round trip per frame and the app is not frame-rate-critical
here, so the loop records the wall-clock time of each frame and the encoder is
handed the real durations. If a capture takes longer than the interval the
recording stays honest rather than silently speeding up.

`clip.scale` is set so the output is **1200 px wide**. The clip is given in CSS
pixels but the scale multiplies *device* pixels on top of the display's ratio, so
the divisor is `innerWidth x devicePixelRatio` — 1200 / (1440 x 2) = 0.4167, not
1200 / 1440. The first implementation used the CSS width alone and wrote 2400 px
frames; the recorder therefore asserts the width of its first frame rather than
trusting the arithmetic. 1200 is what GitHub's README column renders at on a wide
screen; anything larger is bytes the reader pays for and never sees.

### 2.3 Encoding

ffmpeg, two passes, from a concat list carrying each frame's real duration:

```
palettegen  stats_mode=diff      — one palette, weighted to the pixels that move
paletteuse  dither=bayer:bayer_scale=5, diff_mode=rectangle
```

`stats_mode=diff` matters on a UI recording: most of the frame is a static
background whose colours would otherwise dominate the 256-entry palette and
starve the region that actually changes. `diff_mode=rectangle` lets the encoder
emit only the changed rectangle per frame, which is where nearly all of the
compression on a screen recording comes from. `bayer` rather than the default
error-diffusion because ordered dithering is stable frame to frame — Floyd
–Steinberg re-scatters its error every frame and turns a motionless background
into crawling noise, which both looks worse and destroys the inter-frame delta.

#### The waits are truncated, and nothing else is

A real turn is mostly waiting. Measured on a full take: **49 of 55 seconds were
motionless**, in stretches of 14.2 s and 11.6 s while the model thought. A
55-second autoplaying loop is not a hero — nobody reaches the end, and the bytes
go on a still.

So a pass of ffmpeg's own `freezedetect` locates the motionless spans and the
concat list is rebuilt without their tails, keeping **1.2 s** of each. Every
frame that survives carries the duration it was recorded with, so every motion in
the file plays at the speed it happened; what is cut is the gap between motions.
Measured: 56.6 s recorded, 22.8 s shown, 400 frames dropped.

`freezedetect` rather than comparing the frames here, because "nothing happened"
has to be told apart from "the caret blinked and an elapsed-ms counter ticked",
and that judgement is exactly what its noise floor already encodes.

**Not a uniform speed-up**, which was the obvious alternative. A 3x recording
makes the streaming text unreadable and, worse, misrepresents how fast the
*window* responds — which is the one thing a viewer is being invited to measure.
Shortening a pause makes no claim about the speed of anything. The README's
caption says the pauses are shortened, because a demo that quietly edits time is
the kind of thing this repository writes design documents to avoid.

**Budget: 3 MB per file, 6 MB for the pair.** Not an aesthetic limit. The hero is
the first bytes of the repository a stranger downloads, it autoplays with no
control to stop it, and it is fetched before a single word of the README is read.
If the pair does not fit, the levers in order are frame rate (12 → 10 fps), then
duration (trim the dwell after each beat), then width (1200 → 1000). Resolution
is the last thing to go, because a database GUI that cannot be read is not a
demo. Measured values are recorded in §4.

### 2.4 Where it ships, and reduced motion

An autoplaying loop with no pause control is exactly what
`prefers-reduced-motion` exists for, and the repo already honours that setting in
the app itself (`2026-08-04-tailwind-migration.md` §20.5). The README can honour
it too, with no JavaScript and nothing GitHub has to support beyond the
`<picture>` element it already renders for the light/dark pairs — the first
matching `<source>` wins, so the reduced-motion rules go first:

```html
<picture>
  <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)"
          srcset="docs/images/agent-drives-dark.png">
  <source media="(prefers-reduced-motion: reduce)" srcset="docs/images/agent-drives-light.png">
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/agent-drives-dark.gif">
  <img alt="…" src="docs/images/agent-drives-light.gif">
</picture>
```

The two stills are the recording's **final frame**, written by the same run — not
the old `overview` pictures, which show a different arrangement. A reader who has
asked their operating system to stop things moving then sees the frame the
recording ends on, to the pixel: the four tiled panes with the question suspended
in the chat panel.

If a renderer ignores `media` on `<source>` entirely it falls through to the
`<img>`, which is the light-theme GIF: the pre-existing behaviour for every
picture in this README, degraded no further.

The `overview` still is retired from the README by this change. It is not deleted
— it stays in `docs/images/` and `screenshot.mjs` keeps producing it, because it
is the picture design documents link to.

### 2.5 The caption

The line under the hero currently reads:

> Every screenshot in this README was produced by a single `set_layout` MCP call

which stops being true the moment a recording is the hero — a recording is eight
calls, not one, and that is the better claim anyway. It becomes a statement about
provenance rather than about call count.

### 2.6 Files

| file | change |
| --- | --- |
| `apps/desktop/scripts/screenshot.mjs` | `recordAgentDrives`, a frame recorder, an ffmpeg encode step, `agent-drives` in `SHOTS` |
| `docs/images/agent-drives-{light,dark}.gif` | new |
| `docs/images/agent-drives-{light,dark}.png` | new — the final frame, for reduced motion |
| `README.md`, `README.zh-CN.md` | hero swapped, caption reworded |

## 3. Trade-offs

**Drive the window from the capture script and leave the agent out — the first
cut.** Rejected on review, having been built. The argument for it was:

> The embedded agent is `@agentclientprotocol/claude-agent-acp` and needs
> credentials, so the recording could only ever be re-made by someone holding an
> account — against the harness's whole reason for existing, which is that every
> picture in the README is reproducible by anyone who can run the build. It is
> also non-deterministic: the model's wording, its tool order and its latency all
> change between runs, so the README's picture would change meaning every time
> anyone regenerated it. The MCP path shows the same window doing the same
> things, and every frame of it is checkable.

Both halves are true and neither is decisive.

*Reproducibility.* The bar the harness actually sets is that a picture is not
staged, and a live session is not staged — it is less staged than the first cut,
which was a choreography written by hand. The repository already ships numbers
nobody else can reproduce byte for byte: the README's performance table is
measured on one machine and says so. And the credential barrier is not new. A
contributor without a Claude login cannot exercise the chat panel *at all* — it
is a headline feature of the product — so requiring a login to photograph it adds
no boundary that was not already there.

*Determinism.* Real, and the price is named in §2.1: the committed file is one
take rather than a reproducible artifact, guarded by assertions on its shape
rather than on its content. What it buys is the only thing the picture is for. A
deterministic recording that fails to show an agent is not a cheaper version of
the demo; it is a demo of something else.

What settled it was watching the first cut. It is a good recording of a window
rearranging itself, and "itself" is the problem — see §1.2.

Its choreography is **not kept in the tree**. Two recordings, one of which the
README does not use, is machinery that goes stale unwatched: it would keep being
produced by every full run, keep needing review, and answer a question nobody is
asking on the page. The beats are written out in §1.2 and in this section, which
is enough to rebuild it if the README ever grows a place where "an external MCP
client drives this window" is the claim being made. What survives in the script is
the part that was hard — the frame recorder and the encoder — which the live
recording uses unchanged.

**Fake the transcript — seed the chat history on disk so the panel shows a
conversation.** Rejected outright. It would be the one dishonest image in a
repository whose capture harness opens by explaining that a hand-arranged
screenshot "would show the same pixels and prove nothing".

**MP4 or WebM.** Smaller than GIF by an order of magnitude, and they get a pause
control for free. GitHub does render `<video>` in a README — but only for media
uploaded to its own CDN through the web UI, not for a path in the repository, and
the tag is dropped everywhere else the file is read (npm, editors, mirrors, `cat
README.md`). A hero that renders as nothing on a mirror is worse than a heavy
hero.

**Animated WebP or APNG.** Both are genuinely better formats — true colour, far
smaller. Both render on github.com. Neither is safe: APNG falls back to its first
frame in renderers that do not know it, and animated WebP has no fallback at all.
GIF is the only animated format that is *universally* an animation. This is worth
revisiting the day the README is only ever read on github.com, which is not
today.

**Record it by hand with a screen recorder.** Faster to produce once, impossible
to reproduce, and the arrangement would then genuinely be a person dragging
panes — the exact thing §2.1 says is not happening.

**Keep the still and describe the motion in prose.** Cheapest, and it loses the
argument the README is trying to win in its first screenful. A demo that has to
be explained is not a demo.

## 4. Verification

1. **The turn is the agent's, and it did something.** `--only agent-drives
   --verbose` logs every tool call the transcript shows. The run refuses to write
   a file unless the turn finished, the transcript shows at least three tool
   calls, and the workspace ends with a result on screen — so a turn that
   answered in prose without touching the window fails instead of shipping.
2. **The script sets the scene and nothing else.** Between `recorder.start()` and
   `recorder.stop()` the only calls it makes are `send_chat` and the `read_chat`
   poll. Everything visible in those frames after the prompt was decided by the
   agent. This is checkable by reading the function, and it is the property the
   whole document is about — if a later change adds a layout call inside that
   window, the recording stops being evidence.
3. **No permission prompt was left pending.** Asserted on every poll, not only at
   the end; a blocked turn fails the run.
4. **Watch it.** Every beat boundary is inspected before the file is committed.
   The recording must end on a finished workspace with the agent's reply visible,
   and loop back to the opening frame without a jump in window geometry.
5. **Size.** Both files under the §2.3 budget; measured sizes below.
6. **Reduced motion.** With `prefers-reduced-motion: reduce` set, the page must
   show the still — checked in a browser against a local render, since GitHub's
   sanitizer is the one part of this that cannot be tested from the repository.
7. **The stills still build.** `--only overview,agent-asks` continues to produce
   the existing PNGs unchanged in dimensions.
8. **It is one take, and the record says so.** Re-running produces a different
   recording. The committed file is chosen after watching several, and that is a
   weaker guarantee than the stills carry — stated here rather than left for
   someone to discover when their re-run looks nothing like the README.

## 5. What the recording found

Pointing a camera at the real agent immediately produced a bug that nothing else
was going to catch.

The chat panel renders peek's own tool calls in plain language — "Opened a view",
"Ran a query" — and in the first live take it rendered
`chat.tool.peek.read_workspace` instead. The label lookup misses, and an unknown
key falls back to printing itself, which is the documented and correct
degradation (`i18n.test.ts`, "an unknown key renders as the key itself, never as
blank text").

The cause is `f28c464`, the pass that capitalised the brand. It rewrote nine keys
in each locale from `chat.tool.peek.*` to `chat.tool.Peek.*`. That pass was
scoped to front matter — strings a person reads — and a message key is not one;
it is an identifier, spelled the same on both sides of a lookup or not at all.
The tool names it has to match come from the MCP server name, which is `peek` and
was never going to move. It reads like text, so it went with the text.

**Why every existing check stayed green.** The i18n suite's strongest assertion
is catalog *parity*: every locale defines the same keys. Renaming a key in both
locales keeps parity perfectly satisfied and breaks the call site in both
languages at once — the failure mode is invisible precisely because it is
symmetric. Nothing else looked, because a missing translation does not throw; it
renders a plausible-looking string.

**The guard.** `i18n.test.ts` gains a check that reads the *source* rather than
the catalogs: every literal `t('…')` / `tStatic('…')` key in the renderer must
exist in the catalog. It fails on the broken tree naming the file and the key,
which was verified by putting the bug back. It also asserts that the scan found
more than 400 call sites, so renaming `t` or restructuring the renderer breaks
the check loudly instead of retiring it into a vacuous pass — the shipped-CSS
audit had to be rescued from exactly that on 2026-08-24.

Roughly thirty keys are computed rather than literal and are out of the scan's
reach. They are built from prefixes whose literal siblings the scan does pin, so
the residue is small and named rather than pretended away.

### 5.1 Not fixed here: `set_layout` loses a race with its own transcript

One dark take narrated this, in the panel, at the reader:

> The revision keeps bumping because my own chat is streaming; the panel
> structure is unchanged, so I'll apply it without the revision guard.

`set_layout` takes an optimistic-concurrency guard on the workspace revision, and
the agent's own streaming turn bumps that revision — so an agent that reads the
workspace, thinks, and then submits a layout can find its guard stale through no
fault of anything it did. It recovers by resubmitting without the guard, which is
correct and is also the agent talking its way around a rough edge in public.

Recorded, not fixed: it is a concurrency question about what counts as a workspace
change, and it does not belong in a change about a picture. The picture is how it
was found, which is the argument for the picture.

### Measured

`node apps/desktop/scripts/screenshot.mjs --only agent-drives`, against the
default 1,000,000-row fixture, on an Apple M2 Max:

| | dark | light |
| --- | --- | --- |
| frames captured | 711 | 676 |
| recorded | 60.1 s | 57.1 s |
| **shown** (idle trimmed) | **23.9 s** | **22.0 s** |
| idle frames dropped | 429 | 416 |
| dimensions | 1200x750 | 1200x750 |
| GIF | 911 KB | 762 KB |
| final-frame PNG | 230 KB | 238 KB |

The pair costs **1.63 MB of GIF** against the 6 MB budget in §2.3, so none of
the levers had to be pulled. `diff_mode=rectangle` is doing most of that: even
after the idle trim the recording is mostly a static window, so almost every
frame carries a rectangle rather than a picture.

**The two themes are two different takes**, and they say different things — the
model wrote its own summary each time. That is what §2.1 signs up for; the
alternative is a light-mode reader and a dark-mode reader being shown the same
sentence, which would require the sentence to be scripted, which is the thing the
recording exists not to do.

Both takes were chosen after watching, and both required a re-roll. One dark take
ended with the "the agent has replied" toast sitting over the composer, which is
why the shutter now stays open past `AUTO_DISMISS_MS`. Another narrated its own
fight with a stale revision guard (§5.1). The stills are checked frame by frame
the same way the PNGs are.

The tool calls, from the committed light take, in the order the transcript shows
them: `read_workspace`, `list_connections`, `introspect`, `open_view`,
`run_query`, `run_query`, `set_layout`. None of them was asked for by name.

The `<picture>` selection was checked in Chromium against a page carrying the
shipped source order beside the same order with the query inverted to
`(prefers-reduced-motion: no-preference)`. With no preference set the shipped
order resolved to the animated light GIF and the inverted one resolved to the
still — so `media` on `<source>` is honoured for this query, and with `reduce`
set the shipped markup serves the still. Two things this could not settle locally
and that are therefore stated rather than claimed: whether GitHub's HTML
sanitizer keeps a `media` value it has no existing use for, and the dark leg
under an emulated colour scheme. The dark leg is the same `prefers-color-scheme`
source the README already ships for every other picture, so it is not new ground;
the sanitizer is, and if it drops the attribute the page falls through to the
`<img>` and behaves exactly as it does today.

The three stills rebuild unchanged: `--only overview,agent-asks` exits 0 and both
PNGs are still 2880x1800.

One loose end noted rather than fixed here: `million-rows-{light,dark}.png` is
produced by every full run and referenced by neither README. It predates this
change.
