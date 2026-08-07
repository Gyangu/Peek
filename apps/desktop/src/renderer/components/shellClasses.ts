/* ==================================================================
 * Class strings worn by more than one file of the window shell.
 *
 * ## Why this file exists
 *
 * These three were the last rules in `components/app.css` that survived purely
 * because **two modules wear one class**. `.sidebar-head` / `.sidebar-title` are
 * the connection sidebar's head *and* the conversation rail's; `.dot` is the
 * connection light in the sidebar *and* the summary light in the status bar.
 * Whichever module migrated first would either delete a rule the other one needs
 * or restate it as utilities and leave one visual fact with two sources, which is
 * what the migration record rejects throughout. The rail's own round said so in
 * as many words and stopped there, correctly, because it did not own the other
 * half.
 *
 * A shared constant is the third answer. It is one source, it is in JSX's
 * vocabulary rather than CSS's, and it is only available now because all four
 * files landed in one hand.
 *
 * ## Why a module of its own rather than an export from `Sidebar.tsx`
 *
 * `components/chat/index.ts` states that nothing outside its directory should
 * reach into it, and the status bar already imports it; hanging these off
 * `Sidebar.tsx` would put the connect dialog and the first-run guide into the
 * import graph of everything that wants a 7px circle. This file imports nothing,
 * so it cannot introduce a cycle or drag a component along behind a constant.
 *
 * ## Tailwind reads this file
 *
 * Module-level constants are inside the scanner's aperture — both Tailwind's and
 * ours, since the two apertures were aligned; see the header of
 * `__tests__/sourceScan.ts`. A class string here compiles exactly as if it had
 * been typed into a `className`. What that forbids is building one out of
 * fragments: a family prefix glued to a variable is invisible to Tailwind and
 * generates nothing at all, so every state below is written out whole and each
 * complete class name appears somewhere in this file as literal text.
 * ================================================================== */

/**
 * The head of a standing list: a title that gives up its width, then buttons.
 *
 * The children are grouped from the start and the title takes the slack.
 * `justify-between` strands the ＋ in the middle of the title's whitespace the
 * moment a third child arrives, which is what the conversation rail hit first.
 *
 * The letter-spacing is a rung off Tailwind's own ladder rather than a token of
 * its own, and it is a rounding: these heads shipped `letter-spacing: 0.6px` and
 * the rung is `0.05em`, which at this file's 11px type is 0.55px. Five
 * hundredths of a pixel per gap is not worth a name — "it was that number
 * before" is not a reason for a token, which is the rule the shadow ladder and
 * the 5px radii were already decided by. It also lands these heads on exactly
 * the shape `ui/Menu.tsx` gives its section heads, which is what they always
 * were.
 *
 * Worn by `Sidebar.tsx` and `chat/ChatSessionsRail.tsx`.
 */
export const LIST_HEAD =
  'flex h-bar flex-none items-center gap-inset border-b border-border px-snug text-micro tracking-wider text-fg-dim uppercase'

/**
 * The title inside that head: takes the slack so the buttons sit at the end, and
 * gives up its own width first when the title is longer than the column.
 */
export const LIST_HEAD_TITLE = 'min-w-0 flex-1 truncate'

/**
 * The window's status light, in five states.
 *
 * `dot` and `connecting` survive as *names* on top of the utilities, and only
 * those two: `base.css` turns the pulse off under `prefers-reduced-motion` by
 * selecting `.dot.connecting`, and `components/app.css` still holds the
 * animation shorthand and its `@keyframes`. Both of those are written down where
 * they are for reasons on the rules themselves — in particular, naming the
 * animation in `@theme` as an `--animate-*` is **not** available here, because
 * Tailwind's own default theme already carries `--animate-pulse` and a
 * `@keyframes pulse`, and the two collide. Measured against a build.
 *
 * `idle` is hollow rather than grey: in a merged list "not connected" is a real
 * state, and it has to be legible next to a connected row without competing with
 * it. `none` — a solid faint circle — is the status bar's summary light, which
 * says how many connections are ready rather than what any one of them is doing;
 * it was the bare `.dot` rule with no state class on it.
 *
 * Five whole strings rather than a base plus a colour, so that two classes from
 * one utility family can never land on one element. A class list has no cascade;
 * see `ui/CLAUDE.md`.
 */
const DOT = 'dot size-1.75 flex-none rounded-full'

export const CONN_DOT = {
  none: `${DOT} bg-fg-faint`,
  idle: `${DOT} bg-transparent inset-ring inset-ring-fg-faint`,
  ready: `${DOT} bg-ok`,
  connecting: `${DOT} connecting bg-warn`,
  error: `${DOT} bg-err`,
} as const
