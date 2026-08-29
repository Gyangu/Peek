# The status bar's in-flight indicator stops shaking the bar

## What this fixes

Clicking any button in the status bar — "New conversation", "Conversations" —
makes the whole bar flinch.

The cause is not animation, it is layout. `dispatch()` raises `inflight` from 0
to 1 and drops it back as a command enters and leaves (`state/dispatch.ts`),
while `StatusBar` hangs the "N commands in flight" cell off the right of the
`flex-1` spring behind a conditional:

```tsx
<span className="flex-1" />
<ChatEntry />
{inflight > 0 ? <span …>{t('status.inflight', …)}</span> : null}
```

So for a few tens of milliseconds a cell appears out of nowhere and is removed
again, the spring is squeezed narrower, and the "New conversation /
Conversations" pair slides left and springs back. The faster the command, the
more visible the jolt — and local commands are almost all instantaneous, so this
indicator is loudest exactly when it carries the least information.

Boundary: only this indicator's timing and the way it holds space change. The
`inflight` count itself, the semantics of `dispatch`, and every other status bar
cell are untouched. Cells that appear on the left because a view really was
opened — `Tab 1/2` and the like — are content genuinely changing, and are out of
scope.

## The plan

Two changes, both in `components/StatusBar.tsx`.

1. **A delay threshold.** A new `useDelayedFlag(active, delayMs)` returns true
   only once `active` has been continuously true for 200ms, and returns false
   the instant it goes false. The indicator reads that instead of
   `inflight > 0`. Instantaneous commands therefore show no indicator at all —
   this indicator is only worth anything on slow commands, and "a command ran
   for 8ms just now" is not something the user needs to know.

   Going false is not delayed: the indicator should disappear the moment the
   command ends, and every extra millisecond it lingers is fake busyness.

2. **Appearing without squeezing.** The cell becomes permanently present in the
   DOM, toggling `invisible` for visibility, and moves to the **left** of the
   `flex-1` spring. Permanent presence means the width it occupies never appears
   out of nowhere; sitting left of the spring means that even when its width
   changes with `count` (1 → 10), it is the spring that absorbs the difference
   and the buttons on the right do not move.

   `invisible` (`visibility: hidden`) rather than `hidden`: the former keeps the
   box and the latter does not, and keeping the box is the entire point here. It
   remains hidden from screen readers either way.

## Trade-offs

- **Threshold only, no change to how it holds space**: the buttons on the right
  still jump once when a slow command surfaces the indicator. Less often, but
  the shake has not gone, and it now happens at precisely the moment the user is
  watching and waiting.
- **Space only, no threshold**: nothing shakes, but a label still flashes on
  every click. The visual noise is still there, converted from displacement into
  blinking.
- **Give it a fixed width**: this would avoid both the permanent presence and
  the move across the spring, but the width would have to be guessed from the
  longest localised string, Chinese and English are not the same length, and a
  wrong guess is either truncation or dead space. The spring already absorbs it;
  there is nothing to guess.
- **Add a fade transition**: this trades the shake for a 200ms fade, which is
  still motion the user did not ask for, and runs against the restraint the
  "reduce motion" section commits to.

## Verification

By hand:

1. Start the app and click "New conversation" and "Conversations" repeatedly.
   The buttons on the right no longer move, and no "commands in flight" label
   flashes past.
2. Trigger a slow command — connect to a slow-responding connection, or run a
   large query — and confirm the indicator appears after roughly 200ms,
   disappears the moment the command ends, and that "cache" and "rev" on the
   right hold still as it appears and disappears.
