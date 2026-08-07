import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ChatAttachment, ViewId, ViewState } from '@peek/core'
import { useT } from '../../i18n'
import { ConsentDialog } from '../context-actions/ConsentDialog'
import { useContextActions } from '../context-actions/useContextActions'
import { viewTitleOf } from '../panelTitle'
import { attachCandidates, attachmentKindKey, attachmentLabel, stageableAttachment } from './attachments'
import { detachFromChat } from './chatCommands'
import { copyText } from '../../util/clipboard'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'

/**
 * Staged context.
 *
 * ## Where the data is (and is not)
 *
 * These chips are `ChatAttachment` descriptors read straight out of the
 * Workspace mirror — the panel keeps no copy and stages nothing locally. Adding
 * is `chat.attach`, removing is `chat.detach`, and the bar redraws when the
 * patch comes back. That is not ceremony: it is what makes the AI's
 * `read_workspace` and the human's screen agree on what is pinned.
 *
 * ## Two entry points, on purpose
 *
 * A grid selection attaches itself (the data view owns that gesture — a chip bar
 * has no idea which rows are highlighted). This menu covers the other direction:
 * the user is looking at the *chat*, and wants to hand over the workspace, a
 * result set or the SQL of a query without going back to find it.
 *
 * ## Both entry points go through the same gate
 *
 * Staging happens through `useContextActions`, not through `chat.attach`
 * directly, and that is the whole reason it is worth the indirection: the
 * disclosure that this data leaves the machine has to be shown before the *first*
 * attachment, whichever gesture made it. This menu used to dispatch straight past
 * it, which meant a user who only ever attached from here was never told.
 */
export function AttachmentBar({
  viewId,
  attachments,
  views,
}: {
  viewId: ViewId
  attachments: readonly ChatAttachment[]
  views: readonly ViewState[]
}): ReactElement {
  const t = useT()
  const actions = useContextActions()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const candidates = useMemo(
    () =>
      attachCandidates(views, {
        workspace: t('chat.attach.option.workspace'),
        workspaceHint: t('chat.attach.option.workspaceHint'),
        resultOf: (view) => t('chat.attach.option.result', { view }),
        queryOf: (view) => t('chat.attach.option.query', { view }),
        viewName: (view) => viewTitleOf(t, view),
      }),
    [views, t],
  )

  // Dismiss on a click elsewhere or on Escape — the same two gestures every
  // other transient surface in peek closes on.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const remove = useCallback(
    (attachment: ChatAttachment) => {
      void detachFromChat(viewId, [attachment.id])
    },
    [viewId],
  )

  return (
    <div
      className="relative flex-none flex flex-wrap items-center gap-tight px-snug py-inset min-h-head bg-bg-1 shadow-rule-t"
      ref={boxRef}
    >
      <span className="mr-inset text-micro uppercase tracking-wider text-fg-faint">{t('chat.attach.label')}</span>

      {attachments.length === 0 ? (
        <span className="text-micro text-fg-faint">{t('chat.attach.empty')}</span>
      ) : (
        attachments.map((a) => (
          <AttachmentChip key={a.id} attachment={a} onRemove={remove} />
        ))
      )}

      <span className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        title={t('chat.attach.addTitle')}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
        }}
      >
        + {t('chat.attach.add')}
      </Button>

      {open ? (
        <div className="absolute right-2 bottom-full z-20 mb-tight p-inset min-w-60 max-w-90 max-h-70 overflow-auto rounded-control bg-bg-2 border border-border-strong shadow-menu">
          {candidates.length === 0 ? (
            <div className="px-tight py-tight text-micro text-fg-faint">{t('chat.attach.noCandidates')}</div>
          ) : (
            candidates.map((c) => (
              // A menu line, not a control — see NOT_CONTROLS. `base.css` gives
              // it the hit height and the focus ring; these strip the button
              // shape off it and lay the label over its hint.
              <button
                key={c.key}
                type="button"
                className="flex flex-col items-start gap-inset w-full px-tight py-inset text-left rounded-control border-0 bg-transparent hover:not-disabled:bg-bg-hover"
                onClick={() => {
                  setOpen(false)
                  void actions.add(stageableAttachment(c.spec, c.label), viewId)
                }}
              >
                <span>{c.label}</span>
                {c.hint ? <span className="font-mono tabular-nums max-w-full truncate text-micro text-fg-faint">{c.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* Held, not dropped: accepting stages the attachment the user asked for,
          so the gesture survives reading the disclosure. */}
      {actions.consentPending ? (
        <ConsentDialog onAccept={actions.acceptConsent} onCancel={actions.cancelConsent} />
      ) : null}
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
