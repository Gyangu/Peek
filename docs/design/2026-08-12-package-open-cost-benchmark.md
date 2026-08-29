# Measure what one open costs, not what each frame costs

## 1. What this fixes

`2026-08-07-database-packages-from-disk.md` §4duodetricies(e) left a gap open:

> **Half of acceptance criterion 21's gap** — how many bytes opening a Tier C
> view reads, and from where, has no benchmark measuring it today.

The original wording called for a "per-frame work" benchmark. This round changes
that framing, for a reason the design document has already argued: a package's
self-drawn view, once hung there, has a per-frame cost that is **bounded by
construction** — it holds a one-shot `structuredClone` snapshot capped at
`PACKAGE_MAX_ROWS`, subscribes to no data stream, and its viewport is the panel it
was handed (§2.6bis). Writing a "per-frame work" benchmark literally produces **a
number that can never go red**.

What genuinely nobody measures is **the open itself**: how many bytes opening a
package view reads, from where, and how much the host's main thread pays. The units
are bytes and one-off milliseconds.

**Boundary**: no product code changes. The benchmark builds its own iframe,
because turning the fixture into an openable view kind would touch three pieces of
product code that enter the window's chunk, and §4.5's criterion 21 says word for
word that this is not taken (see §4duodetricies(e), item 2).

## 2. The plan

`apps/desktop/scripts/bench-package-frame.mjs`, shaped after `bench-scroll.mjs`:
start a **production build** with an isolated config directory, connect to the
window over CDP, install `fixtures/packages/echo`, then open each of two views N
times — `neo4j` (the only shipping Tier C view) and `echo` (the fixture, at a
fixed size).

### 2.1 Bytes: two sources, checking each other

Which files one open reads is counted from two unrelated sources, and **a
disagreement goes red**:

| source | how it is obtained |
| --- | --- |
| disk | resolve the URL to the file the protocol handler would serve, and `statSync` its size |
| the wire | read the response body back with `Network.getResponseBody` and count bytes |

Counting one source alone misses things, and this is not hypothetical — the first
version missed them. An iframe's **document** is initiated on its behalf by the
parent frame, and only the window's session broadcasts it; only subresources belong
to the frame itself. The first version listened only to the frame's session, so it
dropped `index.html` from the byte total every time and listed it among "files not
read", which read like a finding. Once the window's session was added, the two
sources agreed byte for byte.

`encodedDataLength` is reported alongside but takes no part in the test: for a
`protocol.handle` response it measures **identically zero**, which is precisely the
kind of value that looks like a real number while quietly collapsing a total.

### 2.2 The positive control: not an optional extra

The `echo` fixture's `state.spin` rewrites every node and every edge endpoint each
frame once opened. **Correcting a number written into the document last round**:
§4duodetricies(e) recorded "rewrites 600 attributes per frame", and the measurement
is **1,200** (300 nodes × 2 plus 300 edges × 2). That figure is no longer a
constant in prose — the fixture accumulates `attrWrites` where it writes them, and
the benchmark divides by the frames it drew, so that line is measured.

What the control has to answer is "can the measuring apparatus see a signal". Four
tests: frames must actually **be drawn** during the spin; the attributes written
per frame **must not be fewer than the element count** (loud enough); the
**millisecond difference** between idle and busy must clear a threshold (separable);
and the **element count must not change** across the spin (which turns "1,200
attribute writes and the picture does not move" into an assertion that can go red).
Why a millisecond difference rather than a ratio is in §3 — that was changed after
eleven rounds of measurement.

### 2.3 The occlusion guard, and why three flags are still needed

The guard from `bench-scroll.mjs` is copied: if a rAF does not arrive within five
seconds it errors rather than hanging silently. It paid for itself immediately —
the first three runs all stopped on it, with `visibilityState: "hidden"` on both
the window and the frame.

The cause is not the code: one run takes a minute, and during that minute macOS
marks the window occluded (the terminal running it is in front), whereupon Chromium
marks the page hidden and stops animation ticks. So three flags are added at launch
(`--disable-backgrounding-occluded-windows` and friends) to keep the renderer in a
foreground state.

**A user opening a package view is looking at the window**, so "treated as
foreground" is the state that should be measured. The guard **stays** — it is what
turns "hangs silently" into "one sentence within five seconds", and the cases the
flags do not cover (minimised, display asleep) still need it.

## 3. Trade-offs

**Why not a per-frame benchmark.** See §1: measuring the per-frame budget of
something bounded by construction produces a number that cannot go red. A
performance number pretending to mean something is the same species as "the check
passed but it verified the wrong thing".

**Why the control's test changed from a ratio to a millisecond difference.** This
took two steps, both forced by data.

Step one: the fifth of six calibration rounds went red — the idle side measured
11.38ms (the other five: 0.22 / 0.39 / 0.45 / 0.52 / 1.20), dragging the ratio to
7.6× and below the 10× threshold. That was **not** the apparatus going blind: the
spin side of that same round was 87.1ms, a difference of 75.7ms. The problem is the
statistic itself — the denominator is a fraction of a millisecond, and one polluted
window can wreck it. The response was first to **fix the measurement, not loosen
the threshold**: sample idle three times and take the minimum, leaving the threshold
where it was.

Step two: five re-runs, and the fourth had **all three idle windows polluted**
(7.98 / 13.49 / 30.13ms) for a ratio of 10.5× — a threshold of 10, red by a hair
again. The millisecond difference in that same round was 75.8ms, unmoved. At which
point the conclusion is clear: **a ratio measures how quiet the quiet half is, not
how loud the loud half is**, and what this control has to prove is the latter. So
the test moved to the millisecond difference (a threshold of 20ms, a third of the
smallest interval across eleven rounds, 62ms), with the ratio still reported but not
judged.

The root cause was addressed at the same time: `HeapProfiler.collectGarbage` before
sampling idle. The renderer has just torn down five opens, and a collection landing
in the sampling window is the single largest reason a quiet window measures loud.
The three rounds afterwards had idle at 0.09 / 0.17 / 0.25ms, and the pollution has
not recurred.

**One inverse check taught something in return.** Changing the fixture's spin to
write one attribute per frame **did not go red** — and it drew 114 frames a second
burning 91.7ms of thread time, **more than the genuinely heavy work** (48 frames,
around 80ms). Total thread time over a fixed wall-clock window answers "is a loop
running", not "is each frame expensive". Two things were added: a line in the report
for **thread time per frame** (1.8ms/frame for the heavy work, 0.7ms/frame for the
light — that number does track "expensive"), and a test that **attribute writes per
frame must not be fewer than the element count**, pinning "loud" to two numbers the
fixture measures itself. Re-running that break afterwards goes red.

**Why the time thresholds are so loose.** Across fourteen rounds of unchanged code,
the **median** `ready` per round ranged from 7.1 to 17.8ms, and that 2.5× spread is
the machine, not the application. A threshold has to sit above the worst honest
round, so the resolution of the time half is roughly "2.5× or worse" — it catches "a
package view has started pulling in something enormous" and cannot catch a 30%
regression. **Saying so plainly beats reporting a tight number that goes red every
third round.**

**The byte threshold is a different kind of number.** It has **no** measurement
spread: fourteen rounds × two sources, neo4j is 23,362 B byte for byte and echo is
8,352 B. So 64 KB is not derived from noise, it is a **budget**, guarding against
the accidents a package UI really has (a charting library, a font, an inline image
finding its way into the bundle), not against drift.

## 4. Verification

### 4.1 Calibration and re-runs

Fourteen rounds (six calibration, five re-runs, three after the control was fixed),
each opening each view five times.

| quantity | observed across fourteen rounds | threshold | basis |
| --- | --- | --- | --- |
| bytes to open neo4j | 23,362 B, **byte-identical in every round from both sources** | 64 KB | a budget, not a spread |
| bytes to open echo | 8,352 B, as above | 64 KB | as above |
| median `ready` | 7.1–17.8ms per round | 40ms | 2.4× the worst round |
| median window main thread | 1.6–6.6ms per round | 15ms | 2.3× the worst round |
| control's millisecond difference | 62–87ms | 20ms | a third of the smallest observation |
| attribute writes per frame | 1,200 (identical every round) | ≥ the element count, 600 | measured by the fixture itself |

**The result**: one open of neo4j's `graph` view has the host read **3 files,
23,362 B** (`index.html` + `index.js` + `index.css`), all under that package's own
`ui/`; **837,247 B in the same package go untouched** (most of it the 800 KB driver
bundle). Hanging there, an idle frame costs 0.1–0.3ms per second.

**Four more rounds were run before delivery on 2026-08-12**
(`2026-08-07-…-from-disk.md` §4undetricies(d) lists them round by round), all four
exiting 0 and **widening none of the observed ranges above**: across four rounds ×
two sources, eight counts in all, neo4j is **23,362** byte for byte and echo is
**8,352**, the same figures as the fourteen calibration rounds; median `ready`
**10.2–16.7ms**, median window main thread **2.3–5.3ms**, the control's millisecond
difference **81.5–85.7ms**, attribute writes per frame **1,200** in all four, and
element counts 600 / 600 in all four. **After eighteen rounds, the byte column is
still one number.**

**The time half's resolution has to be stated plainly**: across rounds of unchanged
code the medians range from 7.1 to 17.8ms, a 2.5× spread that comes from the
machine. So the time thresholds catch "a package view has started pulling in
something enormous" and cannot catch a 30% regression. **The byte half does not
have this problem** — it has zero spread and is the one quantity in this benchmark
that can measure finely.

### 4.2 Inverse checks for every guard

| guard | how it was broken | result |
| --- | --- | --- |
| occlusion | remove the three foreground flags | red. On a long run it is the rAF guard (an error within five seconds plus `visibilityState: "hidden"`, three times); on a short run a single rAF still arrives, and the control's "never drew a frame" catches it instead |
| the two-source byte check | read response bodies only from the broadcasting session (the spelling before it was fixed) | red: `index.html` disagrees between the two, reported per file |
| reading out of bounds | have the fixture reference `../driver.mjs` | red: the URL is reported |
| reading out of bounds (encoded bypass) | reference `./%2e%2e/driver.mjs` | red, but **through a different branch** — Chromium normalised the path first; see below |
| the byte budget | inflate the fixture past 64 KB | red: 78,395 B against a budget of 65,536 B |
| time to open | have the fixture busy-wait 120ms before answering `ready` | red: a median of 137.0ms against a ceiling of 40.0ms |
| control: frames were drawn | have the fixture accept `spin` and start no loop | red: `never drew a frame while spinning` |
| control: loud enough | have the spin write one attribute per frame | **did not go red the first time** — see §3; red once the test was added |
| control: element count unchanged | have the spin add one element per frame | red: 600 idle against 648 spinning |

**Two things to record honestly**:

1. The "resolved outside `ui/`" branch in `resolveRequest` **cannot be hit by a
   request a live frame emits** — Chromium normalises the path before broadcasting,
   so both `../driver.mjs` and `%2e%2e/driver.mjs` arrive as `/driver.mjs`, and what
   actually catches them is the "file does not exist" line after it. The branch stays
   (against URL shapes normalisation cannot fold) but the comment says plainly that it
   is not the one doing the work.
2. The window main thread ceiling has no inverse check of its own — it shares its
   wiring with the already-verified time-to-open ceiling, and there is no way to
   break it into red without breaking something else too. **That cell is inferred
   from the shape, not measured.**
