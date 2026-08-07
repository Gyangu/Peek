import { Fragment, memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { ToolCallRecord, ToolCallStatus } from '@peek/core'
import { useT, type TFunction } from '../../i18n'
import { copyText } from '../../util/clipboard'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'
import { highlight } from './highlight'
import { TOKEN_CLASS } from './Markdown'
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
    // A folded step: no card, no border, no surface. It has to be in the
    // transcript — dropping it would make the transcript disagree with what the
    // agent did — but it is bookkeeping, so it is drawn as one muted line.
    return (
      <div className="flex items-center gap-tight my-tight px-tight py-inset text-micro text-fg-faint">
        <StatusMark status={call.status} />
        <span className="flex-none whitespace-nowrap text-fg">{t('chat.tool.lookup')}</span>
        <span className={`font-mono tabular-nums ${ARGS}`}>{summarizeToolInput(call.rawInput, 60)}</span>
      </div>
    )
  }

  const summary = summarizeToolInput(call.rawInput)
  const result = toolResultText(call)
  const elapsed = call.endedAt === undefined ? null : Math.max(0, call.endedAt - call.startedAt)

  const mutating = parsed.isPeek && parsed.mutatesWorkspace

  return (
    <div
      className={`my-tight rounded-control overflow-hidden border bg-bg-1 ${cardEdge(parsed, call.status)}${
        // A wash down the leading edge, on top of the card's own surface: the
        // agent did not read this window, it changed it. `bg-bg-1` is the colour,
        // `bg-linear-to-r` the image — two properties, so they compose rather
        // than fight.
        mutating ? ' bg-linear-to-r from-accent/10 to-transparent to-55%' : ''
      }`}
      onContextMenu={menu.open(null)}
    >
      <button
        type="button"
        // A disclosure header, not a control (see NOT_CONTROLS): it spans the
        // card and opens a region. These strip `base.css`'s button shape back off
        // it and leave the hit height and the focus ring, which are floors.
        className="flex items-center gap-snug w-full min-w-0 px-snug py-tight text-left rounded-none border-0 bg-transparent hover:not-disabled:bg-bg-hover"
        onClick={() => {
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        title={open ? t('chat.tool.collapse') : t('chat.tool.expand')}
      >
        <StatusMark status={call.status} />
        <span className="flex-none whitespace-nowrap text-fg">{displayName(parsed, t)}</span>
        {parsed.isPeek ? (
          <span className={`${BADGE} ${mutating ? 'bg-accent-dim text-fg' : 'bg-bg-3 text-fg-dim'}`}>
            {mutating ? t('chat.tool.actedOnWindow') : t('chat.tool.readWindow')}
          </span>
        ) : (
          // Anything that is not peek's gets said so, loudly. peek's whole
          // permission vocabulary is phrased around window operations ("Read
          // this window", "Changed this window"), and a bare unlabelled card for
          // a shell command read *tamer* than `read_workspace` — the exact
          // inversion of the truth. The session sandbox should now make this
          // branch unreachable; it stays because a badge that is never shown
          // costs nothing and a missing one cost the user their bearings.
          <span className={`${BADGE} bg-warn text-warn-ink font-semibold`} title={t('chat.tool.outsideTitle')}>
            {parsed.server === null
              ? t('chat.tool.outside')
              : t('chat.tool.via', { server: parsed.server })}
          </span>
        )}
        {summary === '' ? null : <span className={`font-mono tabular-nums ${ARGS}`}>{summary}</span>}
        <span className="flex-1" />
        {elapsed === null ? null : (
          <span className={`font-mono tabular-nums ${META}`}>{t('chat.tool.elapsed', { ms: elapsed })}</span>
        )}
        <span className={META} aria-hidden="true">
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
        <div className="px-snug pt-tight pb-snug bg-bg border-t border-border">
          {/* The raw identifier, always: the friendly label is for reading, this
              is what a bug report and the agent's own logs are keyed by. */}
          <div className="font-mono tabular-nums mb-tight text-micro text-fg-faint break-all">{call.title}</div>

          <div className={SECTION}>{t('chat.tool.arguments')}</div>
          <JsonBlock text={formatToolInput(call.rawInput)} />

          <div className={SECTION}>{t('chat.tool.result')}</div>
          {result === '' ? (
            <div className={EMPTY}>{t('chat.tool.noResult')}</div>
          ) : (
            <pre className={`font-mono tabular-nums ${PAYLOAD}`}>{result}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
})

/**
 * The card's border, which is the only place its provenance is drawn.
 *
 * Written as a ladder rather than as four classes layered on one element,
 * because a class list has no cascade: `border-accent border-warn` is resolved
 * by Tailwind's emission order, not by the order here. In CSS this was four
 * rules whose winner depended on specificity and file position — the same
 * ordering, but readable only by reading the whole file in order. One colour,
 * chosen once, and the reason for each rung is what the rung says.
 */
function cardEdge(parsed: ParsedToolTitle, status: ToolCallStatus): string {
  // The window changed. Loudest, and it outranks a failure: a mutation that then
  // failed is still the thing the reader has to go and look at.
  if (parsed.isPeek && parsed.mutatesWorkspace) return 'border-accent'
  // Not peek's, so it did something this window cannot account for. Marked more
  // loudly than peek's own calls, not less.
  if (!parsed.isPeek) return 'border-warn'
  if (status === 'failed') return 'border-err-border'
  // peek's, and it only read. The quiet end of the scale.
  return 'border-accent-dim'
}

/** A pill, in one of three fills. Each fill states its own surface *and* its own ink. */
const BADGE = 'flex-none px-tight rounded-dialog text-micro leading-ui whitespace-nowrap'

/** The argument summary: takes the slack, ellipsizes rather than wraps. */
const ARGS = 'flex-auto min-w-0 truncate text-micro text-fg-faint'

/** The two readings pinned to the trailing edge — elapsed time, and the chevron. */
const META = 'flex-none text-micro text-fg-faint'

const SECTION = 'mt-tight mb-inset text-micro uppercase tracking-wider text-fg-faint'
const EMPTY = 'text-micro text-fg-faint'

/** Arguments and result: a scrolling box with a ceiling, so one cannot eat the transcript. */
const PAYLOAD =
  'm-0 px-snug py-tight max-h-65 overflow-auto rounded-control bg-bg-1 border border-border ' +
  'text-micro leading-prose whitespace-pre-wrap break-words'

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

/**
 * The mark's colour, and — for the one that is running — its turn.
 *
 * `motion-reduce:animate-none`: nothing is carried by the rotation. A running
 * call still shows ◐ in --color-accent beside an elapsed-time readout that keeps
 * counting, so stopping the spin costs the reader nothing. `@keyframes chat-spin`
 * is in chat.css; `--animate-chat-spin` names it from theme.css.
 */
const TOOL_MARK: Record<ToolCallStatus, string> = {
  completed: 'text-ok',
  failed: 'text-err',
  in_progress: 'text-accent animate-chat-spin motion-reduce:animate-none',
  pending: 'text-fg-faint',
}

function StatusMark({ status }: { status: ToolCallStatus }): ReactElement {
  const t = useT()
  return (
    <span
      className={`flex-none w-3 text-center ${TOOL_MARK[status]}`}
      title={t(statusKey(status))}
      aria-hidden="true"
    >
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
  if (text === '') return <div className={EMPTY}>—</div>
  return (
    <pre className={`font-mono tabular-nums ${PAYLOAD}`}>
      <code>
        {tokens.map((tok, i) =>
          tok.kind === 'plain' ? (
            <Fragment key={i}>{tok.text}</Fragment>
          ) : (
            <span key={i} className={TOKEN_CLASS[tok.kind]}>
              {tok.text}
            </span>
          ),
        )}
      </code>
    </pre>
  )
}
