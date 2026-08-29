# Peek app icon exploration

2026-08-03

> B, "the slice", has been chosen and wired into the Electron build. The original
> three-way comparison is kept in this directory; the final delivery and its
> verification record are in `FINAL.md`.

## 1. Design constraints

This round follows the `app-icon-optimization` review method:

- differentiate against competitors first, rather than starting from the
  database category's conventional symbols;
- at most two primary foreground elements per candidate, and no text;
- the dominant silhouette has to stay legible at 16/32/64px;
- check on light backgrounds, dark backgrounds and in the Dock together;
- 1024×1024 as the master, kept flat, layered and editable as SVG;
- this round compares *marks* only. Colour, optical sizing and exported
  resources are tested separately once one is chosen.

The `imagegen` rules explicitly recommend constructing vectors directly, rather
than substituting a generative bitmap, for icons in an existing repository that
need deterministic geometry and editable SVG. So no image model produced the
final or candidate geometry here; the built-in image generation would only be
called for a mood board or a material study, and its output kept as reference.

The correspondence with Apple's current workflow: a 1024×1024 square master;
background and foreground on separate layers; a flat source first, with system
effects — transparency, shadow, lighting — applied afterwards. Every candidate
in this directory is two or three flat layers and can be split for Icon Composer
once chosen; the final Electron delivery still goes through PNG / ICNS / ICO.

## 2. Brand definition

**Position**: peek is a read-only database workspace that an AI can operate and
a person can always see. Human clicks and AI tool calls travel the same Command
Bus and change the same interface state.

**Audience**: developers, data engineers and SREs who need to inspect real data
quickly, and tool authors wiring AI agents into a local development workflow.

**Personality**: clear-headed, restrained, collaborative.

**The visual promise**: **whether a person or an AI initiates it, the data only
ever happens on one plainly visible working surface.**

## 2.1 Repository and build audit

- The runtime icon comes from `apps/desktop/resources/icon.png`: read by relative
  path in development, and from `process.resourcesPath` once packaged; macOS also
  calls `app.dock.setIcon()` explicitly. That PNG is currently the rejected dark
  generative-3D "bracket plus nine-square grid" direction, with an ICNS and an
  ICO beside it.
- The macOS installer icon travels a different path:
  `apps/desktop/build/icon.svg` → `pnpm icon` → `apps/desktop/build/icon.icns` →
  `package-mac.mjs`. That SVG is currently a database cylinder, which is also an
  explicitly forbidden direction.
- Before the choice, the runtime PNG and the installer ICNS were not the same
  source. `apps/desktop/build/icon.svg` is now the single 1024×1024 layered
  master, and `pnpm icon` generates PNG / ICNS / ICO uniformly, which removes
  that drift.
- With B chosen, the active resources above have been replaced from that one
  master; the original competitive study and the three-way comparison are kept
  separately.

## 3. Three concept directions

### A — Confluence

Two entry paths merging into one clean trunk. It draws neither "the human" nor
"the AI", only the product's real structural difference: two command sources
entering one channel. Three words: **two paths, one**.

- elements: plate plus a single confluence mark
- strengths: semantically closest to the Command Bus; the silhouette holds at
  16px; not a database-category cliché
- risks: too sharp an angle approaches a Git branch or a funnel; refinement has
  to keep it broad and un-arrow-like

### B — Clear Slice

One whole working surface opened by a single continuous cut. It says "look at a
slice of real data" while avoiding eyes, magnifiers and database cylinders.
Three words: **opening a slice**.

- elements: plate plus a working surface carrying a negative-space cut
- strengths: settled geometry, unambiguous positive and negative space, suits
  monochrome and small-size variants
- risks: too rectilinear and it reads as a generic window; the cut's proportions
  are what carry the recognition

### C — Shared Surface

Two planes from different sources forming one whole along a single tenoned seam.
Not two windows side by side, but one shared surface. Three words: **two faces,
interlocked**.

- elements: two complementary planes (the plate is only a carrier)
- strengths: the strongest statement of collaboration; blue and mint map
  naturally onto the two kinds of operator
- risks: at 16px the seam depends on optical adjustment more than A or B do; it
  must not turn into a jigsaw-puzzle toy

## 4. Initial review

| direction | legibility 16–64px | light/dark contrast | category differentiation | simplicity | brand alignment | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A Confluence | 9 | 8 | 8 | 9 | 10 | **44/50** |
| B Clear Slice | 9 | 8 | 9 | 9 | 9 | **44/50** |
| C Shared Surface | 8 | 8 | 8 | 8 | 10 | **42/50** |

**B, the slice, is chosen.** Checked on a real 16/32/64px grid, its positive and
negative space is the steadiest, and it is the least like an architecture
diagram; it says "seeing data through a working surface" while avoiding eyes,
magnifiers, cylinders and stacked panes. A's product semantics are the most
accurate, but as it stands it reads as the letter Y first; C tells the best brand
story but depends most on a pixel-exact seam at 16px. Having chosen B, the next
round should move three variables only — the cut's curvature, the working
surface's share of the frame, and the plate's lightness — and stop changing
concept and colour at the same time.

## 5. Files

- `competitive-matrix.md`: 16 competitor and reference samples, and what to
  steer clear of
- `candidates/a-confluence.svg`: A's editable 1024×1024 master
- `candidates/b-clear-slice.svg`: B's editable 1024×1024 master
- `candidates/c-shared-surface.svg`: C's editable 1024×1024 master
- `concept-board.svg` / `concept-board.png`: black and white, sizes, light and
  dark backgrounds, and a Dock comparison
- `b-final-validation.svg` / `b-final-validation.png`: B's final validation board
  after refinement
- `FINAL.md`: the final geometry, the export path and the verification results
- `previews/`: real 16/32/64px raster output for each candidate
