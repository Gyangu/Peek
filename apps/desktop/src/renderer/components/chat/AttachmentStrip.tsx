import type { ReactElement } from 'react'
import type { ChatAttachment } from '@peek/core'
import { useT } from '../../i18n'
import { attachmentKindKey, attachmentLabel } from './attachments'
import { copyText } from '../../util/clipboard'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'

/**
 * Staged context: the chips, and nothing else.
 *
 * ## Where the data is (and is not)
 *
 * These chips are `ChatAttachment` descriptors read straight out of the
 * Workspace mirror — the panel keeps no copy and stages nothing locally. Adding
 * is `chat.attach`, removing is `chat.detach`, and the strip redraws when the
 * patch comes back. That is not ceremony: it is what makes the AI's
 * `read_workspace` and the human's screen agree on what is pinned.
 *
 * ## Why this is a strip inside the composer and no longer a bar of its own
 *
 * An attachment's whole life is "the next message". Drawn as its own bar with
 * its own edge it read as a sibling of the input box, when it is part of it —
 * and it took a row of height saying "Nothing attached" for as long as nothing
 * was. It renders nothing at all when the list is empty now; what a person can
 * do about that is a line in the composer's hint, where they are already
 * looking. See design/2026-08-14-composer-inline-context.md §2.1.
 *
 * Adding lives in `Composer` (the `@` and the button both open `AttachMenu`),
 * which is also where the disclosure dialog is held: `useContextActions` gates
 * the *first* attachment of a user's life whichever gesture made it, and this
 * strip makes none of them.
 *
 * Removing is dispatched by `Composer` too, and that is not tidiness: a chip
 * staged by `@` has a word in the draft, and taking the chip away has to take
 * the word with it (design/2026-08-14-composer-inline-context.md §2.3.1). Only
 * the composer holds the draft.
 */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: readonly ChatAttachment[]
  onRemove: (attachment: ChatAttachment) => void
}): ReactElement | null {
  if (attachments.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-tight pb-tight">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * A chip's classes, for the two things a chip can be.
 *
 * `staged` is context the *next* message will carry and can still be taken back;
 * a receipt is a record of what a past message already carried. Both are drawn
 * here rather than twice, because they were one rule (`.chat-chip`) before the
 * migration and splitting them across two components is how the two drift.
 * `MessageItem` imports it for the receipt; the direction is that way round
 * because a chip is born on this bar.
 *
 * Two things worth knowing about the shape:
 *
 *  - the chip is 20px tall and that is what `leading-ui` is doing. It has to be
 *    tall enough to hold the ✕, which is `<Button variant="ghost" size="sm" icon>`
 *    — the smallest control in the window, and the one place `--spacing-hit`
 *    bends, because a chip is an inline token in a wrapping strip rather than a
 *    row. Removing an attachment by mistake costs one re-add.
 *  - a receipt reads quieter than a staged chip **in its colours, at full
 *    opacity**. It used to say `opacity: 0.75`, which composites the whole chip
 *    and put the --color-accent kind label at 3.72:1 somewhere
 *    `theme-contrast.test.ts` structurally could not look. The parameter could
 *    not be tuned out of it either: --color-accent only clears 4.5 at about
 *    α = 0.88, by which point nothing is muted. See
 *    design/2026-08-02-ui-legibility-baseline.md §2.2.1.
 *
 * A receipt carrying a truncation notice is the one thing on either strip the
 * user has to actually read, so it keeps the loud treatment and gains an amber
 * edge — which a failure then overrides with red.
 */
export function chipClasses(state: { receipt: boolean; detail: boolean; failed: boolean }): {
  box: string
  kind: string
  label: string
  detail: string
} {
  const loud = !state.receipt || state.detail || state.failed
  return {
    box:
      'inline-flex items-center gap-tight max-w-65 pl-tight text-micro leading-ui rounded-full bg-bg-2 border ' +
      (state.receipt ? 'pr-tight ' : 'pr-inset ') +
      (state.failed
        ? 'border-err'
        : state.detail
          ? 'border-warn'
          : state.receipt
            ? 'border-border'
            : 'border-border-strong'),
    kind: `text-micro ${loud ? 'text-accent' : 'text-fg-dim'}`,
    label: `font-mono truncate ${loud ? 'text-fg-dim' : 'text-fg-faint'}`,
    detail: `max-w-55 truncate text-micro ${state.failed ? 'text-err' : 'text-warn'}`,
  }
}

/**
 * One staged attachment.
 *
 * Its own component now, because it holds a menu and a menu needs state. The ×
 * stays: this bar is where a person removes something they staged by mistake,
 * and that is worth a visible target even at 20px. What the menu adds is the
 * label — the chip truncates, so the only way to read a long table name in full
 * was the `title` tooltip, and the only way to *use* it was to retype it.
 */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment
  onRemove: (a: ChatAttachment) => void
}): ReactElement {
  const t = useT()
  const menu = useContextMenu<null>()
  const label = attachmentLabel(attachment)
  const chip = chipClasses({ receipt: false, detail: false, failed: false })

  return (
    <span className={chip.box} title={label} onContextMenu={menu.open(null)}>
      <span className={chip.kind}>{t(attachmentKindKey(attachment.kind))}</span>
      <span className={chip.label}>{label}</span>
      {/* 18px → 20px, the `sm` rung. The legibility baseline §2.4 planned
          exactly this swap; the chip grows 2px and that was measured.
          One deliberate loss when the rung landed: this ✕ used to turn
          --color-err on hover. Un-staging an attachment is not destructive — it
          is re-addable in one click — so `danger` would overstate it, and
          `ghost`'s own hover already says the control is live. Colour spent on a
          reversible act is colour unavailable for an irreversible one. */}
      <Button
        variant="ghost"
        size="sm"
        icon
        label={t('chat.attach.remove')}
        onClick={() => {
          onRemove(attachment)
        }}
      >
        ×
      </Button>
      {menu.state ? (
        <Menu
          label={t('menu.chip.label')}
          at={menu.state.at}
          nodes={[
            {
              kind: 'item',
              id: 'chip.copyLabel',
              label: t('menu.chip.copyLabel'),
              onSelect: () => {
                copyText(label)
              },
            },
            {
              kind: 'item',
              id: 'chip.remove',
              label: t('menu.chip.remove'),
              // Nothing is lost that cannot be staged again in one gesture, so
              // no `confirm` — the tone alone is the whole warning it deserves.
              tone: 'danger',
              onSelect: () => {
                onRemove(attachment)
              },
            },
          ]}
          onClose={menu.close}
        />
      ) : null}
    </span>
  )
}
