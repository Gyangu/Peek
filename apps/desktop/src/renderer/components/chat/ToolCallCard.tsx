import { Fragment, memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ToolCallRecord, ToolCallStatus } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { copyText } from '../../util/clipboard'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'
import { highlight } from './highlight'
import { PlanCard } from './PlanCard'
import {
  extractPlan,
  formatToolInput,
  parseToolTitle,
  summarizeToolInput,
  toolResultText,
  type ParsedToolTitle,
} from './toolCalls'

/**
 * One tool call.
 *
 * ## The case this component is really for
 *
 * peek hands the agent its own MCP server, so "the model called a tool" and "the
 * window in front of you just changed" are the same event. A card that renders
 * `mcp__peek__open_view` as one more grey row leaves the user watching their
 * layout rearrange itself with no account of why.
 *
 * So a peek tool call is marked, named in plain language ("Opened a view"), and
 * labelled with whether it *changed* this window or only read it. The raw tool
 * name stays visible next to it — the friendly label is for reading, the
 * identifier is for reporting a bug — and the arguments are always one click
 * away.
 *
 * ## Folded, not dropped
 *
 * The Claude agent defers tool schemas, so a single logical call arrives as a
 * `ToolSearch` step followed by the real one. `ToolSearch` renders as a single
 * muted line instead of a full card: dropping it would make the transcript
 * disagree with what the agent actually did, and showing it in full would double
 * the length of every tool sequence.
 */
export const ToolCallCard = memo(function ToolCallCard({
  call,
}: {
  call: ToolCallRecord
}): ReactElement {
  const t = useT()
  const parsed = useMemo(() => parseToolTitle(call.title), [call.title])
  const plan = useMemo(() => extractPlan(call), [call])
  const [open, setOpen] = useState(false)
  const menu = useContextMenu<null>()

  if (plan) return <PlanCard entries={plan} />

  if (parsed.isToolSearch) {
    return (
      <div className="chat-tool lookup">
        <StatusMark status={call.status} />
        <span className="chat-tool-name">{t('chat.tool.lookup')}</span>
        <span className="chat-tool-args mono">{summarizeToolInput(call.rawInput, 60)}</span>
      </div>
    )
  }

  const summary = summarizeToolInput(call.rawInput)
  const result = toolResultText(call)
  const elapsed = call.endedAt === undefined ? null : Math.max(0, call.endedAt - call.startedAt)

  return (
    <div
      className={`chat-tool${parsed.isPeek ? ' peek' : ' outside'}${parsed.mutatesWorkspace ? ' mutating' : ''} ${call.status}`}
      onContextMenu={menu.open(null)}
    >
      <button
        type="button"
        className="chat-tool-head"
        onClick={() => {
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        title={open ? t('chat.tool.collapse') : t('chat.tool.expand')}
      >
        <StatusMark status={call.status} />
        <span className="chat-tool-name">{displayName(parsed, t)}</span>
        {parsed.isPeek ? (
          <span className={`chat-tool-badge${parsed.mutatesWorkspace ? ' mutating' : ''}`}>
            {parsed.mutatesWorkspace ? t('chat.tool.actedOnWindow') : t('chat.tool.readWindow')}
          </span>
        ) : (
          // Anything that is not peek's gets said so, loudly. peek's whole
          // permission vocabulary is phrased around window operations ("Read
          // this window", "Changed this window"), and a bare unlabelled card for
          // a shell command read *tamer* than `read_workspace` — the exact
          // inversion of the truth. The session sandbox should now make this
          // branch unreachable; it stays because a badge that is never shown
          // costs nothing and a missing one cost the user their bearings.
          <span className="chat-tool-badge outside" title={t('chat.tool.outsideTitle')}>
            {parsed.server === null
              ? t('chat.tool.outside')
              : t('chat.tool.via', { server: parsed.server })}
          </span>
        )}
        {summary === '' ? null : <span className="chat-tool-args mono">{summary}</span>}
        <span className="grow" />
        {elapsed === null ? null : (
          <span className="chat-tool-elapsed mono">{t('chat.tool.elapsed', { ms: elapsed })}</span>
        )}
        <span className="chat-tool-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {/* Both halves are evidence — the arguments go into a bug report, the
          result gets pasted back to a colleague — and until now the only way to
          get either was to expand the card and select the text by hand. The card
          need not even be open: the menu reads the call, not the DOM. */}
      {menu.state ? (
        <Menu
          label={t('menu.tool.label')}
          at={menu.state.at}
          nodes={[
            {
              kind: 'item',
              id: 'tool.copyInput',
              label: t('menu.tool.copyInput'),
              onSelect: () => {
                copyText(formatToolInput(call.rawInput))
              },
            },
            {
              kind: 'item',
              id: 'tool.copyOutput',
              label: t('menu.tool.copyOutput'),
              disabled: result === '',
              onSelect: () => {
                copyText(result)
              },
            },
          ]}
          onClose={menu.close}
        />
      ) : null}

      {open ? (
        <div className="chat-tool-body">
          {/* The raw identifier, always: the friendly label is for reading, this
              is what a bug report and the agent's own logs are keyed by. */}
          <div className="chat-tool-raw mono">{call.title}</div>

          <div className="chat-tool-section">{t('chat.tool.arguments')}</div>
          <JsonBlock text={formatToolInput(call.rawInput)} />

          <div className="chat-tool-section">{t('chat.tool.result')}</div>
          {result === '' ? (
            <div className="chat-tool-empty">{t('chat.tool.noResult')}</div>
          ) : (
            <pre className="chat-tool-out mono">{result}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
})

/** Human label: peek's own tools get one, everything else shows its bare name. */
function displayName(parsed: ParsedToolTitle, t: TFunction): string {
  if (!parsed.isPeek) return parsed.tool
  switch (parsed.tool) {
    case 'open_view':
      return t('chat.tool.peek.open_view')
    case 'activate_view':
      return t('chat.tool.peek.activate_view')
    case 'move_view':
      return t('chat.tool.peek.move_view')
    case 'set_layout':
      return t('chat.tool.peek.set_layout')
    case 'run_query':
      return t('chat.tool.peek.run_query')
    case 'connect':
      return t('chat.tool.peek.connect')
    case 'read_workspace':
      return t('chat.tool.peek.read_workspace')
    case 'introspect':
      return t('chat.tool.peek.introspect')
    case 'list_connections':
      return t('chat.tool.peek.list_connections')
    default:
      // A peek tool this build has no label for is still peek's: show the
      // identifier rather than inventing prose for it.
      return parsed.tool
  }
}

function StatusMark({ status }: { status: ToolCallStatus }): ReactElement {
  const t = useT()
  return (
    <span className={`chat-tool-mark ${status}`} title={t(statusKey(status))} aria-hidden="true">
      {status === 'completed' ? '✔' : status === 'failed' ? '✕' : status === 'in_progress' ? '◐' : '○'}
    </span>
  )
}

function statusKey(
  status: ToolCallStatus,
):
  | 'chat.tool.status.pending'
  | 'chat.tool.status.in_progress'
  | 'chat.tool.status.completed'
  | 'chat.tool.status.failed' {
  switch (status) {
    case 'pending':
      return 'chat.tool.status.pending'
    case 'in_progress':
      return 'chat.tool.status.in_progress'
    case 'completed':
      return 'chat.tool.status.completed'
    case 'failed':
      return 'chat.tool.status.failed'
  }
}

/** Arguments, coloured as JSON. Cheap: it only runs for an expanded card. */
function JsonBlock({ text }: { text: string }): ReactElement {
  const tokens = useMemo(() => highlight(text, 'json'), [text])
  if (text === '') return <div className="chat-tool-empty">—</div>
  return (
    <pre className="chat-tool-in mono">
      <code>
        {tokens.map((tok, i) =>
          tok.kind === 'plain' ? (
            <Fragment key={i}>{tok.text}</Fragment>
          ) : (
            <span key={i} className={`tok-${tok.kind}`}>
              {tok.text}
            </span>
          ),
        )}
      </code>
    </pre>
  )
}
