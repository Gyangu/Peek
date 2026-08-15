import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useT } from '../i18n'
import { dispatch } from '../state/dispatch'
import { notify } from '../state/notifyStore'
import { Button } from '../ui/Button'

/**
 * What a first launch says instead of nothing.
 *
 * An empty peek used to be a blank window and a `＋` button, which described one
 * of the three things it can do. The other two are invisible by construction:
 * the MCP server is already listening — an AI client could be talking to this
 * window within a minute — and there is a chat panel with an agent that reaches
 * back in through that same endpoint. Neither leaves any trace in the UI until
 * you already know to look for it.
 *
 * So the empty state is three offers rather than a sentence, and each one is a
 * thing that happens when clicked, not an instruction to go and read something.
 * The MCP line carries the registration command **and copies it**, because the
 * previous answer to "how do I connect Claude to this" was to open a JSON file
 * in a terminal.
 *
 * It disappears the moment there is a connection. This is not a tutorial to be
 * dismissed and re-found; it is what the empty list looks like.
 */
export function FirstRunGuide({
  canConnect,
  onConnect,
  onOpenSettings,
}: {
  /**
   * Whether any database package is installed. False disables step 1 and says
   * why — the guide is the *most* likely place to meet that state, because a
   * peek with no packages also has no connections and this is what an empty list
   * draws. See design 2026-08-11 §2.2.
   */
  canConnect: boolean
  onConnect: () => void
  onOpenSettings: () => void
}): ReactElement {
  const t = useT()
  const [hint, setHint] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // The command is only worth offering once the endpoint is really up; a line
  // copied while the port was still being bound would name the wrong one.
  useEffect(() => {
    let cancelled = false
    void dispatch('mcp.read', {}).then((status) => {
      if (!cancelled && status?.listening === true && status.hint !== '') setHint(status.hint)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const copyCommand = (): void => {
    if (hint === null) return
    void navigator.clipboard.writeText(hint).then(
      () => {
        setCopied(true)
      },
      () => {
        notify('warn', t('mcp.copyFailed'))
      },
    )
  }

  return (
    /* `.empty-hint` is the shared shape of "this list has nothing in it" — the
       guide is what the empty connection list *is*, not a card laid over one —
       and it centres its text, which this does not.

       `textAlign` stays inline, and the reason changed: `text-left` used to be
       rejected by the type scale's usage scan, which now allows the alignment
       keywords. What still rules it out is the cascade — `.empty-hint` is
       unlayered in `components/app.css`, so a `text-left` in `@layer utilities`
       loses to it and the override silently stops working. Same wall TreeView
       records on its own error notice. */
    <div className="grid gap-loose px-snug py-loose text-left leading-prose text-fg-faint">
      <div>
        <div className="text-fg">{t('firstRun.title')}</div>
        <div>{t('firstRun.subtitle')}</div>
      </div>

      <Step index={1} title={t('firstRun.connectTitle')} body={t('firstRun.connectBody')}>
        {/*
         * `conn.openDialog`, not `conn.open`. This button dispatches nothing —
         * `onConnect` is Sidebar's `openConnectDialog()`, which puts a form on
         * screen; the `conn.open` command is dispatched later, by the form, if the
         * user completes it.
         *
         * It said `conn.open` for exactly one day. An action id names what the
         * control actually triggers, and borrowing a real command name for a
         * control that does not send it is precisely the "shipped under the wrong
         * name" failure §1.4 of the design record warns about — committed, by me,
         * in the change that added the warning. The rule cannot be checked
         * statically (nothing can tell what a callback eventually reaches), so it
         * is written here and in spec.ts rather than pretended into CI.
         */}
        <Button
          variant="primary"
          action="conn.openDialog"
          disabled={!canConnect}
          title={canConnect ? undefined : t('connect.noPackages')}
          onClick={onConnect}
        >
          {t('firstRun.connectAction')}
        </Button>
        {/* Written out rather than left to the button's tooltip. This is the one
            surface with room for a sentence, and a greyed-out primary button is
            exactly where a user stops and wonders whether peek is broken. */}
        {canConnect ? null : <div className="text-err">{t('connect.noPackages')}</div>}
      </Step>

      <Step index={2} title={t('firstRun.mcpTitle')} body={t('firstRun.mcpBody')}>
        <Button variant="ghost" disabled={hint === null} onClick={copyCommand}>
          {copied ? t('firstRun.mcpCopied') : t('firstRun.mcpAction')}
        </Button>
        <Button variant="ghost" onClick={onOpenSettings}>
          {t('firstRun.mcpSettings')}
        </Button>
        {hint === null ? <div className="text-err">{t('firstRun.mcpDown')}</div> : null}
      </Step>

      <Step index={3} title={t('firstRun.chatTitle')} body={t('firstRun.chatBody')}>
        <Button
          variant="ghost"
          onClick={() => {
            void dispatch('view.open', { spec: { kind: 'chat' } })
          }}
        >
          {t('firstRun.chatAction')}
        </Button>
      </Step>
    </div>
  )
}

function Step({
  index,
  title,
  body,
  children,
}: {
  index: number
  title: string
  body: string
  children: ReactElement | (ReactElement | null)[]
}): ReactElement {
  return (
    <div className="grid gap-tight">
      {/* The number is a position in a list, and reads the same in every language. */}
      <div className="text-fg">{`${String(index)}. ${title}`}</div>
      <div>{body}</div>
      <div className="flex flex-wrap gap-tight mt-tight">{children}</div>
    </div>
  )
}
