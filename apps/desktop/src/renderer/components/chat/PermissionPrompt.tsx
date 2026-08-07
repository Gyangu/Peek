import { useEffect, useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import type { PendingPermission, PermissionOption, ViewId } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { Button } from '../../ui/Button'
import { respondPermission } from './chatCommands'
import { orderPermissionOptions, permissionButtonVariant } from './permissionOptions'
import { parseToolTitle } from './toolCalls'

/**
 * The moment the agent asks a human.
 *
 * This is the load-bearing part of letting a model drive the window. peek's own
 * MCP tools can open views, run queries and rearrange the layout, so the honest
 * question is not "may I call a tool" but **"may I change what you are looking
 * at"** — and the prompt says so, in those words, when the tool is one of peek's
 * mutating ones.
 *
 * Three rules it keeps:
 *
 *  - the tool's real identifier is always shown next to the friendly sentence.
 *    A permission dialog that only paraphrases is a dialog you cannot audit;
 *  - the arguments are shown. `inputPreview` is truncated by main before it ever
 *    reaches Workspace, so this renders a preview and never claims to be the
 *    whole input;
 *  - the button labels are localized by `kind`, but the value sent back is the
 *    agent's own `optionId`. Those two strings differ (`allow` vs `allow_once`),
 *    and the agent only accepts the id.
 *
 * ## Nothing here is the primary button
 *
 * `allow_once` used to carry `.primary` — the brightest control on the screen —
 * while rejecting was the quietest. That is a thumb on the scale, and the fix is
 * not to put the thumb on the other side: making *reject* the loud one would
 * manufacture confirmation fatigue, and a user who has been trained that the big
 * button is the safe one will press it on the call that actually mattered. So
 * the two one-shot answers are drawn with equal weight, exactly as Chrome's
 * permission bubble and macOS's own dialogs draw theirs, and the visual budget
 * is spent instead on the one option that changes anything *beyond this call*:
 * `allow_always` is marked, ordered last among the allows, and explained.
 *
 * ## It says `group`, not `alertdialog`
 *
 * It used to claim `role="alertdialog"` with no `aria-modal` and no focus
 * management, which is a promise to a screen reader that the rest of this
 * component does not keep. And a focus trap would be the wrong fix: the panel is
 * modal in *attention*, not in the DOM — it sits above the composer rather than
 * over the window precisely so the user can scroll back through the transcript
 * and read the tool call that led here before deciding. So it tells the truth
 * instead: a labelled group that announces itself assertively, with focus moved
 * to the container — **not to a button**. Tab reaches the answers from there,
 * and no keystroke aimed at the composer can approve anything by inertia.
 */
export function PermissionPrompt({
  viewId,
  permission,
}: {
  viewId: ViewId
  permission: PendingPermission
}): ReactElement {
  const t = useT()
  const parsed = useMemo(() => parseToolTitle(permission.toolName), [permission.toolName])
  const boxRef = useRef<HTMLDivElement | null>(null)

  // The container, never a button. See the note above: this is what puts the
  // answers one Tab away without putting one of them under the return key.
  useEffect(() => {
    boxRef.current?.focus()
  }, [permission.requestId])

  const title = parsed.isPeek
    ? parsed.mutatesWorkspace
      ? t('chat.permission.titlePeek')
      : t('chat.permission.titlePeekRead')
    : t('chat.permission.title')

  const options = useMemo(() => orderPermissionOptions(permission.options), [permission.options])
  const hasAlways = options.some((o) => o.kind === 'allow_always')

  return (
    <div
      ref={boxRef}
      tabIndex={-1}
      // The panel takes focus when it appears (see above) so that Tab reaches the
      // answers. That is a programmatic focus, not a keyboard one, and a ring
      // drawn around a panel the user did not navigate to reads as an error
      // state — so `focus:` gives it none and the ring is kept for
      // `focus-visible:`, where it means something. `focus-visible:outline-solid`
      // is not decoration: `focus:outline-none` sets `--tw-outline-style: none`,
      // and `focus-visible:outline-2` reads that variable rather than restating
      // `solid`, so without it the ring would compile to a width with no style.
      // All three are quoted under the variant they are worn with rather than as
      // bare stems, because a bare stem here compiles into a rule no element
      // wears — `scripts/audit-shipped-css.mjs` refuses to ship one.
      className={`flex-none m-tight px-snug py-snug rounded-control select-text border focus:outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
        // Peek's own mutating tools change the window in front of you, so the
        // question changes with them and the panel changes colour to say so.
        parsed.mutatesWorkspace ? 'bg-accent-bg border-accent' : 'bg-warn-bg border-warn'
      }`}
      role="group"
      aria-label={t('chat.permission.label')}
      aria-live="assertive"
    >
      <div className="mb-tight font-semibold text-fg">{title}</div>

      <div className={ROW}>
        <span className={KEY}>{t('chat.permission.tool')}</span>
        <span className={`font-mono tabular-nums ${VAL}`}>{permission.toolName}</span>
      </div>

      {permission.inputPreview === '' ? null : (
        <div className={ROW}>
          <span className={KEY}>{t('chat.permission.arguments')}</span>
          <span className={`font-mono tabular-nums ${VAL}`}>{permission.inputPreview}</span>
        </div>
      )}

      <div className="mt-snug mb-snug text-micro text-fg-dim">{t('chat.permission.waiting')}</div>

      <div className="flex flex-wrap gap-tight">
        {options.map((option) => (
          <Button
            key={option.optionId}
            variant={permissionButtonVariant(option)}
            // Marked `human-only` on the one surface where the word is
            // load-bearing: an agent that can answer its own permission prompt
            // has no permission system. Nothing reads `data-peek-exposure` yet,
            // and that is the point — when something does, this answer is
            // already in the DOM rather than being decided by whoever writes the
            // reader. `control-spec.test.ts` fails if this file ever says
            // otherwise.
            //
            // One id for all four answers: it names the act, and *which* answer
            // was given is the `optionId` in the handler, not something the
            // handle needs to carry.
            action="chat.respondPermission"
            exposure="human-only"
            onClick={() => {
              void respondPermission(viewId, option.optionId, permission.requestId)
            }}
            // The agent's own wording, kept as a tooltip: the localized label is
            // for reading, this is what the agent thinks it offered.
            title={option.name}
          >
            {optionLabel(option, t)}
          </Button>
        ))}
      </div>

      {/*
        The note under the one answer that outlives this call.
        `permissionButtonVariant` draws `allow_always` as `caution` — dashed, in
        --color-warn — and that is a mark rather than a promotion: it has to read
        as "this one is different", not as "this one is recommended". None of the
        four buttons is `primary`, for the reason in the header. `caution` is
        also deliberately not `danger`: answering always is not destructive, it
        is a choice whose consequence outlives the moment, which is the whole
        distinction the control spec §3.6 keeps the two variants apart for.
      */}
      {hasAlways ? (
        <div className="mt-snug text-micro text-fg-faint">{t('chat.permission.alwaysNote')}</div>
      ) : null}
    </div>
  )
}

/**
 * The key/value lines that show the tool and its arguments.
 *
 * A fixed key column, so the two labels and the two values each line up on one
 * edge — and `grow-0 shrink-0 basis-17` rather than `flex-none basis-17`,
 * because `flex-none` is the `flex` shorthand and carries a `flex-basis` of its
 * own. Which of the two won would be Tailwind's emission order to decide, not
 * this file's. Three longhands say one thing each.
 */
const ROW = 'flex gap-snug my-inset text-micro'
const KEY = 'grow-0 shrink-0 basis-17 text-fg-faint'
const VAL = 'flex-1 min-w-0 text-fg-dim break-words'

function optionLabel(option: PermissionOption, t: TFunction): string {
  switch (option.kind) {
    case 'allow_once':
      return t('chat.permission.kind.allow_once')
    case 'allow_always':
      return t('chat.permission.kind.allow_always')
    case 'reject_once':
      return t('chat.permission.kind.reject_once')
    case 'reject_always':
      return t('chat.permission.kind.reject_always')
    default:
      // An option kind this build does not know still has to be offerable, and
      // the agent's English name is better than nothing at all.
      return option.name
  }
}
