import type { ReactElement } from 'react'
import type { ViewState } from '@peek/core'
import { RESULT_CACHE_MAX_BYTES, collectPanels, collectionRefLabel, describeView, findPanel } from '@peek/core'
import { isMacPlatform, shortcutHints } from '../hooks'
import { useT, type TFunction } from '../i18n'
import { dispatch, useBusyStore } from '../state/dispatch'
import { useCacheStats, useResult } from '../state/useResult'
import { useWorkspace, useWorkspaceStore } from '../state/workspaceStore'
import { formatBytes, formatCount, formatMs } from '../util/format'
import { toggleChatRail, useChatRailStore } from './chat'
import { CONN_DOT } from './shellClasses'
import { Button } from '../ui/Button'
import { ErrorCenterButton } from './error-center/ErrorCenter'
import { lookupViewKind } from '../packages/viewKinds'

/**
 * Bottom status bar: connection state, current view, query time and row count,
 * result-cache watermark, and the language switch.
 *
 * Reference implementation for the rest of the UI — three patterns worth copying:
 *   - `useT()` in the component body, so a language switch re-renders this bar;
 *   - plural messages get `count` for category selection *plus* the already
 *     formatted number, because `t()` never formats numbers itself;
 *   - identifiers stay untranslated: `rev`, a collection label such as
 *     `public.orders`, the query text. They are how a human and MCP refer to the
 *     same thing, so they have to read identically in both places.
 */
export function StatusBar(): ReactElement {
  const t = useT()
  const ws = useWorkspace()
  const stats = useCacheStats()
  const inflight = useBusyStore((s) => s.inflight)
  const resyncCount = useWorkspaceStore((s) => s.resyncCount)
  const bridgeMissing = useWorkspaceStore((s) => s.bridgeMissing)
  const ready = useWorkspaceStore((s) => s.ready)

  const panel = ws?.focusedPanel ? findPanel(ws.layout, ws.focusedPanel) : null
  // The *visible* tab of the focused panel. A status bar describing a view the
  // user cannot see would be worse than one describing nothing.
  const view = panel?.activeViewId && ws ? (ws.views[panel.activeViewId] ?? null) : null
  const resultId = view && 'resultId' in view ? view.resultId : undefined
  const snap = useResult(resultId)
  const meta = resultId && ws ? (ws.results[resultId] ?? null) : null

  const conns = ws ? Object.values(ws.connections) : []
  const readyCount = conns.filter((c) => c.status === 'ready').length
  const cachePct = Math.round((stats.bytes / RESULT_CACHE_MAX_BYTES) * 100)

  return (
    /*
     * 26px, not 22px. The bar carries real buttons (new conversation, the rail
     * toggle, the error centre), a button is 25.4px tall, and `overflow-hidden`
     * on a 22px bar was quietly clipping every one of them.
     *
     * `statusbar` carries no box any more, but it stays: `app.css` colours the
     * error centre's unseen count through `.statusbar .err`, on a span that
     * belongs to another module.
     */
    <div className="statusbar flex h-head flex-none items-center gap-snug overflow-hidden shadow-rule-t bg-bg-1 px-snug text-micro whitespace-nowrap text-fg-dim">
      {/* The bar's cells — the connection dot, the view description, the row
          count, the cache watermark — are all this shape: a row of things that
          line up on one baseline. It was `.statusbar .cell`, and `.seg` before
          that, which was also the connect dialog's segmented-control class; two
          unrelated rules wearing one name is what made the control layer block
          this file for a reason belonging to another one. */}
      <span className="flex items-center gap-tight">
        {/* The summary light, not a connection's own: `none` is the faint solid
            circle the bare `.dot` rule used to draw, and it means "nothing is
            ready" rather than "this one is idle". See `shellClasses.ts`. */}
        <span className={readyCount > 0 ? CONN_DOT.ready : CONN_DOT.none} />
        {t('status.connected', { ready: readyCount, total: conns.length })}
      </span>

      <PanelPosition />
      <TabPosition />

      {view ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          <span className="flex items-center gap-tight" title={describeView(view)}>
            {describeViewLocalized(t, view)}
          </span>
        </>
      ) : null}

      {resultId ? (
        <>
          <span className="h-divider w-px flex-none bg-border-strong" />
          <span className="font-mono tabular-nums flex items-center gap-tight">
            {t('status.rows', { count: snap.rowCount, rows: formatCount(snap.rowCount) })}
            {meta?.elapsedMs !== undefined ? ` · ${formatMs(meta.elapsedMs)}` : ''}
            {snap.status === 'running' ? ` · ${t('status.receiving')}` : ''}
          </span>
        </>
      ) : null}

      <span className="flex-1" />

      {/* The window's only always-reachable way into a conversation. Everything
          else that opens one needs an *empty* panel to put it in, which is a
          state a user stops having about a minute after they start working. */}
      <ChatEntry />

      {inflight > 0 ? (
        <span className="flex items-center gap-tight">{t('status.inflight', { count: inflight })}</span>
      ) : null}

      <span
        className={
          cachePct > 85
            ? 'flex items-center gap-tight text-warn'
            : 'flex items-center gap-tight'
        }
        title={t('status.cacheTitle')}
      >
        {t('status.cache', { size: formatBytes(stats.bytes), pct: cachePct })}
      </span>

      {resyncCount > 0 ? (
        <span className="flex items-center gap-tight text-warn" title={t('status.resyncTitle')}>
          {t('status.resync', { count: resyncCount })}
        </span>
      ) : null}

      {bridgeMissing ? (
        <span className="flex items-center gap-tight text-err">{t('status.preloadMissing')}</span>
      ) : null}

      {/* Until the first snapshot lands. It used to sit in the title bar, next to
          a *second* copy of the bridge line above — the bar had become a place
          for state that belongs down here. Suppressed when the bridge is missing:
          then "syncing" is not what is happening, it is never going to sync. */}
      {!ready && !bridgeMissing ? (
        <span className="flex items-center gap-tight">{t('app.syncing')}</span>
      ) : null}

      {/* The one place in the window that remembers a failure past the toast that
          announced it. Silent until something has actually gone wrong. */}
      <ErrorCenterButton />

      <span className="font-mono tabular-nums flex items-center gap-tight" title={t('status.revTitle')}>
        rev {ws?.rev ?? '—'}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Where the focused panel sits in the tiling, as `Panel 2/4`.
 *
 * The panel ring says *which* panel is active; this says *where* it is in the
 * visual order — the same depth-first order `⌘1 … ⌘9` addresses and the same one
 * `read_workspace` lists panels in, so a user and the AI count panels alike. It
 * also gives the keyboard model somewhere to be discovered: the tooltip is the
 * only place in the window that spells the chords out.
 *
 * Hidden with a single panel, where "Panel 1/1" is noise.
 */
function PanelPosition(): ReactElement | null {
  const t = useT()
  const ws = useWorkspace()
  if (!ws) return null
  const panels = collectPanels(ws.layout)
  if (panels.length < 2) return null
  const index = panels.findIndex((p) => p.id === ws.focusedPanel)
  if (index < 0) return null

  const hints = shortcutHints(isMacPlatform())
  return (
    <>
      <span className="h-divider w-px flex-none bg-border-strong" />
      <span
        className="flex items-center gap-tight"
        title={t('keyboard.panelPositionTitle', {
          focusKeys: hints.focus,
          panelDigitKeys: hints.panelDigit,
          moveKeys: hints.move,
        })}
      >
        {t('keyboard.panelPosition', { index: index + 1, total: panels.length })}
      </span>
    </>
  )
}

/**
 * Which tab of the focused panel is showing, as `Tab 2/3`.
 *
 * Hidden below two tabs, for the same reason `PanelPosition` hides below two
 * panels: "Tab 1/1" is a word for a fact the view name beside it already gives.
 *
 * Its tooltip carries more weight than it looks. `⌘1 … ⌘9` used to focus panels
 * and now selects tabs, and `⌘W` used to close a panel and now closes a tab —
 * two chords whose meaning moved under anyone with the old habit. This tooltip
 * and the panel one next to it are the only written record of that in the whole
 * window.
 */
function TabPosition(): ReactElement | null {
  const t = useT()
  const ws = useWorkspace()
  if (!ws?.focusedPanel) return null
  const panel = findPanel(ws.layout, ws.focusedPanel)
  if (!panel || panel.viewIds.length < 2 || panel.activeViewId === null) return null
  const index = panel.viewIds.indexOf(panel.activeViewId)
  if (index < 0) return null

  const hints = shortcutHints(isMacPlatform())
  return (
    <>
      <span className="h-divider w-px flex-none bg-border-strong" />
      <span
        className="flex items-center gap-tight"
        title={t('keyboard.tabPositionTitle', {
          tabDigitKeys: hints.tabDigit,
          lastTabKey: hints.lastTab,
          cycleKeys: hints.cycleTab,
          closeTabKey: hints.closeTab,
        })}
      >
        {t('keyboard.tabPosition', { index: index + 1, total: panel.viewIds.length })}
      </span>
    </>
  )
}

/* ------------------------------------------------------------------ */

/**
 * How long a query gets to be before the status bar elides it. Mirrors the cut-off
 * in core's `describeView`, so the line and its English tooltip break at the same
 * word.
 */
const QUERY_PREVIEW_CHARS = 120

/**
 * The focused view, described in one line, in the reader's language.
 *
 * Deliberately not `describeView()` from core: that string is fixed to English
 * because MCP and the logs read it, and `Namespace tree · 3 nodes expanded` is
 * prose, not an identifier — left as it is, it would sit untranslated in an
 * otherwise translated status bar. Core says as much in its own doc comment.
 *
 * The kind label comes from the same `view.kind.*` messages `panelTitle()` uses,
 * so the tab above and the status line below name a view the same way. What goes
 * *into* the sentence is left alone: a collection label, the query text and the
 * inspector's ref kind are identifiers.
 *
 * The English original stays one hover away in the `title` tooltip — that is the
 * text worth pasting into a bug report.
 */
function describeViewLocalized(t: TFunction, view: ViewState): string {
  switch (view.kind) {
    case 'table':
      return t('view.describe.table', {
        kind: t('view.kind.table'),
        ref: collectionRefLabel(view.ref),
        offset: view.page.offset,
        limit: view.page.limit,
      })
    case 'query': {
      const oneLine = view.text.replace(/\s+/g, ' ').trim()
      return t('view.describe.query', {
        kind: t('view.kind.query'),
        text: oneLine.length > QUERY_PREVIEW_CHARS ? `${oneLine.slice(0, QUERY_PREVIEW_CHARS)}…` : oneLine,
      })
    }
    case 'inspector':
      return t('view.describe.inspector', { kind: t('view.kind.inspector'), ref: view.ref.kind })
    case 'tree':
      return t('view.describe.tree', { kind: t('view.kind.tree'), count: view.expanded.length })
    case 'vector':
      return t('view.describe.vector', {
        kind: t('view.kind.vector'),
        collection: view.collection,
        topK: view.topK,
      })
    // A conversation has no ref, no query and no connection to name, so the
    // message count is the only thing here worth a line in the status bar. The
    // agent's status is already a light in the panel's own toolbar.
    case 'chat':
      return t('view.describe.chat', { kind: t('view.kind.chat'), count: view.messageCount })
    // English, unlike every branch above: a package's own `describe` is fixed to
    // English by the same contract that fixes core's (MCP reads it), and the
    // catalog cannot hold messages for a kind it has never seen.
    case 'package':
      return lookupViewKind(view.packageKind)?.contract.describe(view)
        ?? t('view.packageMissing', { kind: view.packageKind })
  }
}

/* ------------------------------------------------------------------ */

/**
 * New conversation, and the switch for the conversation rail.
 *
 * Two buttons rather than one, because they answer two different questions —
 * "let me ask something" and "where did that conversation go" — and folding the
 * first into a menu would put a click in front of the commonest one. The rail's
 * own header carries a `＋` of its own; this one is what makes a new
 * conversation reachable while the rail is collapsed.
 *
 * They live in the status bar because that is the only surface in peek that is
 * always present regardless of what the layout is doing. The pre-existing entry
 * points were both conditional on emptiness (an empty panel, or no connections
 * at all), which meant the feature disappeared exactly when the window started
 * being useful.
 *
 * A new conversation is opened with no `panelId`: `view.open` then puts it in the
 * focused panel, which is where the user is looking.
 */
function ChatEntry(): ReactElement {
  const t = useT()
  const collapsed = useChatRailStore((s) => s.collapsed)

  return (
    <>
      {/*
       * These carried `ghost seg` until the control layer arrived. `seg` on a button
       * resolved to `.statusbar .seg` — `display: flex; align-items: center; gap:
       * 5px` — which is exactly what a control already sets, so the class simply had
       * nothing left to say here. It went on meaning something for the eight cells
       * in this bar, and after the Tailwind migration it is what those cells spell
       * out in place: `flex items-center gap-tight`.
       *
       * `md`, not `sm`, even though 20px would fit a 26px bar more comfortably.
       * The bar is 26px *because* the legibility baseline (§2.3) raised it from 22
       * to hold a 24px control; dropping these to `sm` would spend that change and
       * put the only two buttons down here back under the hit floor. Measured after
       * the fact — the first pass did exactly that.
       *
       * Worth recording because the ledger comment on this file named the wrong
       * blocker. It said `.seg` carries `border-radius`, which is true of the
       * *other* `.seg` — `.segmented .seg`, the connect dialog's segmented control.
       * Two unrelated classes share one name, and a name-based fence has to take
       * the stricter meaning for both, so the diagnosis looked right for the wrong
       * reason. What actually unblocked this file was the buttons not needing the
       * class at all.
       */}
      <Button
        variant="ghost"
        title={t('chat.sessions.new')}
        onClick={() => {
          void dispatch('view.open', { spec: { kind: 'chat' } })
        }}
      >
        {t('chat.sessions.new')}
      </Button>
      <Button
        variant="ghost"
        title={t('chat.sessions.railToggleTitle')}
        aria-pressed={!collapsed}
        onClick={toggleChatRail}
      >
        {t('chat.sessions.title')}
      </Button>
    </>
  )
}

