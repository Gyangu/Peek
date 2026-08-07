/* ==================================================================
 * The dialog shell, as class strings, worn by four files in three
 * directories.
 *
 * ## Why this file exists
 *
 * `styles.css` held a six-rule vocabulary for the window's dialogs — the scrim,
 * the panel, its head, its title, its body, its foot — and every one of them was
 * worn by more than one module: the value expansion, the connect form, the
 * settings dialog and the one-time disclosure. Whichever of the four migrated
 * first would either delete a rule the other three still need or restate it and
 * leave one visual fact with four sources. A shared constant is the third
 * answer, and it is the same one `shellClasses.ts` reached for when the sidebar
 * head and the conversation rail turned out to be one head. Read that file's
 * header too: everything it says about the scanner applies here unchanged.
 *
 * ## Sizes are inline styles, not tokens
 *
 * Three of the four dialogs answer "how wide should I be against this window"
 * with a `min()` of a pixel width and a viewport fraction, and one of them
 * answers the same question on the vertical axis. None of those is a step on a
 * scale anything else composes from, and putting one in the spacing namespace
 * would mint a legal padding and a legal gap of the same name — three generated
 * classes for one fact. `error-center/ErrorCenter.tsx` made this exact call for
 * its own panel and named these two dialogs while doing it; this is that call,
 * from the other side.
 *
 * What used to make it a *rule* rather than an inline style was the cascade: the
 * panel's width was declared unlayered, an unlayered declaration outranks every
 * layer at any specificity, and so a width in `@layer utilities` would have
 * compiled and applied to nothing. That is gone with the rule. An inline style
 * was always going to win, which is why the connect form has been using one all
 * along with a comment saying it could not do otherwise.
 *
 * ## One rounding
 *
 * The panel's corner was 7px and is now the 8px rung. There is no 7px rung and
 * "it was that number before" is not a reason for a token — the same call the
 * shadow ladder and the 5px corners were already decided by. 6px and 8px are
 * equally near, and 8 is the one that keeps the dialog rounder than the popup
 * menu, which is the relationship the odd number was stating.
 *
 * Migration record §17.4.
 * ================================================================== */

import type { CSSProperties } from 'react'

/**
 * The scrim, and the box that centres the dialog on it.
 *
 * Covers the window, dims it, and stacks above every panel and rail. The number
 * is 500 and it is unchanged; note that it is *below* the popup menu's backdrop
 * at 600, whose own comment says the opposite. Nothing depends on that today —
 * the right-click menu closes before the disclosure opens, on purpose — so it is
 * recorded here rather than repaired by a migration.
 */
export const MODAL_MASK = 'fixed inset-0 z-500 flex items-center justify-center bg-scrim'

/**
 * The panel: a column that clips its own corners, on the window's deepest
 * shadow because it is the only surface with a scrim beneath it.
 *
 * Carries no width and no height. Every caller states its own, because the four
 * dialogs disagree about all of them — see `MODAL_SIZE`.
 */
export const MODAL_SHELL =
  'flex flex-col overflow-hidden rounded-dialog border border-border-strong bg-bg-1 shadow-modal'

/**
 * The size the generic dialog is, and the base the other three vary from.
 *
 * Spread it and override the axis that differs rather than restating both:
 * a class list has no cascade and neither does a spread, but the spread's
 * winner is the one written last in the literal, which is decided here rather
 * than by an emission order nobody controls.
 */
export const MODAL_SIZE: CSSProperties = { width: 'min(760px, 86vw)', maxHeight: '80vh' }

/** The title strip: fixed height, and the only bar in the window that is not the window's own. */
export const MODAL_HEAD =
  'flex h-bar flex-none items-center gap-snug border-b border-border bg-bg-2 pr-tight pl-snug'

/** The dialog's name inside that strip: takes the slack, so the controls sit at the end. */
export const MODAL_TITLE = 'flex-1 font-semibold'

/**
 * The scrolling middle: worn by the value expansion, the connect form and the
 * settings pane.
 *
 * The zero minimum height is the load-bearing half of it. A flex item's
 * automatic minimum is its own content, so without that override this box
 * refuses to shrink and pushes the foot out through the bottom of a shell that
 * clips — which is not "the foot scrolled away", it is "the foot is gone".
 * (Written in words rather than named: prose in this directory is scanned like
 * code, and a class in a sentence ships as a real rule — migration record §8.3.)
 *
 * The disclosure dialog is the fourth caller and deliberately does **not** wear
 * this one. It needs the scrolling for exactly the reason above — it was the one
 * dialog whose buttons could be clipped out of reach, and the record of that is
 * in `context-actions/ConsentDialog.tsx` and in its own test — but it states its
 * own padding, because its frame is unlike the other three on purpose and that
 * unlikeness is what marks it as the dialog gating what leaves the machine.
 */
export const MODAL_BODY = 'min-h-0 flex-1 overflow-auto p-snug'

/** The button row at the bottom, trailing-aligned. */
export const MODAL_FOOT = 'flex flex-none justify-end gap-snug border-t border-border px-snug py-snug'
