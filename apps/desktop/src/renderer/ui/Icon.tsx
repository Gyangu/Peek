import type { ReactNode } from 'react'

import { ICONS, type IconName } from './icons'
import { ICON_SIZES, type ControlSize } from './spec'

/**
 * An icon, and nothing else.
 *
 * Three things are decided here so that no call site decides them:
 *
 * - **The size comes from the rung**, never from a caller. A size that depends
 *   on what somebody typed is not a size — the same argument `CONTROL_SIZES`
 *   makes for the buttons themselves. `<Button>` hands its own rung down, so an
 *   icon inside a control never states one.
 * - **The colour is always `currentColor`.** Not merely convenient: the render
 *   probe measures contrast by reading back framebuffer pixels, so an icon that
 *   inherits its container's text colour is *covered* by the audits that already
 *   exist. One that carries its own colour is a hole in them.
 * - **It is always `aria-hidden`.** An icon is never an accessible name; the
 *   name comes from the `<Button>`'s `label` or from sibling text. That was
 *   already the practice at every call site, and practice is the thing that
 *   holds until somebody is in a hurry. Here it is unwritable.
 *
 * There is deliberately no `<IconButton>`. `<Button variant icon label>` is
 * already the one entrance to the control layer, and this codebase spent a whole
 * round collapsing three parallel spellings of one button into it.
 *
 * Design record: docs/design/2026-08-15-icon-set.md
 */
export function Icon({ name, size = 'md' }: { name: IconName; size?: ControlSize }): ReactNode {
  const Glyph = ICONS[name]
  return <Glyph size={ICON_SIZES[size]} aria-hidden="true" focusable="false" />
}
