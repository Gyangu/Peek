# B "the slice" — final delivery

Status: chosen, refined and wired in, 2026-08-03.

## The final design

- A 1024×1024 flat SVG master; no text, gradients, glass, 3D or generative
  detail.
- Two primary visual elements: a near-black plate and a blue working surface.
  The continuous negative-space cut is not a third object sitting on top.
- At least 122 master pixels of material remain at either end of the cut, which
  still leaves roughly 2px of solid at a direct scale to 16px.
- The plate uses the project near-black `#171A21`; the working surface uses the
  project accent `#4D9CFF`; the `#66707A` hairline comes from the interface's
  strong border step, and exists for the boundary against a dark Dock.
- Three words: **opening a data slice**.

## Wiring

The single source is `apps/desktop/build/icon.svg`.

`pnpm icon` generates all of the following from that one SVG:

- `apps/desktop/build/icon.icns`
- `apps/desktop/resources/icon.png`
- `apps/desktop/resources/icon.icns`
- `apps/desktop/resources/icon.ico`

The ICO is built from PNG-compressed frames at 16, 24, 32, 48, 64, 128 and
256px; the ICNS carries the slots required for 16, 32, 64, 128, 256, 512 and
1024px. The macOS packaging script additionally copies the runtime PNG to
`Contents/Resources/icon.png` and verifies it is byte-identical to the source
resource.

## app-icon-optimization review

| criterion | score | note |
| --- | ---: | --- |
| legibility at 16–64px | 9/10 | the negative space does not break up; the end fragments survive |
| contrast on light and dark | 9/10 | the blue mark stays visible, the plate keeps a restrained boundary |
| category differentiation | 9/10 | no cylinder, animal, letterform, eye or window stack |
| simplicity | 9/10 | two primary visual elements, no text |
| brand alignment | 9/10 | takes the UI near-black and accent blue directly |
| **total** | **45/50** | fit to carry on as the long-term product mark |

## Verification results

- The SVG's XML structure is valid; the generator script's syntax is valid.
- Running `pnpm icon` twice in a row leaves the SHA-256 of all four final
  resources unchanged.
- All seven ICO frames and every ICNS size slot are readable by system tools.
- `pnpm package` succeeds, producing an arm64 macOS `.app` that passes ad-hoc
  signature verification.
- The ICNS inside the package matches the build resource, and the runtime PNG is
  present and identical to the repository's copy.
