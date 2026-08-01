import type { ReactElement } from 'react'
import type { ViewState } from '@peek/core'
import { RESULT_CACHE_MAX_BYTES, collectPanels, collectionRefLabel, describeView, findPanel } from '@peek/core'
import { isMacPlatform, shortcutHints } from '../hooks'
import { LOCALES, setLocale, useLocale, useT, type TFunction } from '../i18n'
import { useBusyStore } from '../state/dispatch'
import { useCacheStats, useResult } from '../state/useResult'
import { useWorkspace, useWorkspaceStore } from '../state/workspaceStore'
import { formatBytes, formatCount, formatMs } from '../util/format'

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
    <div className="statusbar">
      <span className="seg">
        <span className={`dot ${readyCount > 0 ? 'ready' : ''}`} />
        {t('status.connected', { ready: readyCount, total: conns.length })}
      </span>

      <PanelPosition />
      <TabPosition />

      {view ? (
        <>
          <span className="sep" />
          <span className="seg" title={describeView(view)}>
            {describeViewLocalized(t, view)}
          </span>
        </>
      ) : null}

      {resultId ? (
        <>
          <span className="sep" />
          <span className="seg mono">
            {t('status.rows', { count: snap.rowCount, rows: formatCount(snap.rowCount) })}
            {meta?.elapsedMs !== undefined ? ` · ${formatMs(meta.elapsedMs)}` : ''}
            {snap.status === 'running' ? ` · ${t('status.receiving')}` : ''}
          </span>
        </>
      ) : null}

      <span className="grow" />

      {inflight > 0 ? <span className="seg">{t('status.inflight', { count: inflight })}</span> : null}

      <span className={cachePct > 85 ? 'seg warn' : 'seg'} title={t('status.cacheTitle')}>
        {t('status.cache', { size: formatBytes(stats.bytes), pct: cachePct })}
      </span>

      {resyncCount > 0 ? (
        <span className="seg warn" title={t('status.resyncTitle')}>
          {t('status.resync', { count: resyncCount })}
        </span>
      ) : null}

      {bridgeMissing ? <span className="seg err">{t('status.preloadMissing')}</span> : null}

      <LanguageSwitch />

      <span className="seg mono" title={t('status.revTitle')}>
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
      <span className="sep" />
      <span
        className="seg"
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
      <span className="sep" />
      <span
        className="seg"
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
  }
}

/* ------------------------------------------------------------------ */

/**
 * The language switch.
 *
 * Cycles rather than opening a menu: with two locales a menu is more clicks than
 * the thing it opens, and the code stays correct for a third — the button always
 * shows the language you would get next.
 *
 * Locale names are endonyms and never go through `t()`; a picker that says
 * "Chinese" to someone who only reads Chinese helps nobody.
 */
function LanguageSwitch(): ReactElement {
  const t = useT()
  const locale = useLocale()
  const index = LOCALES.findIndex((l) => l.id === locale)
  const next = LOCALES[(index + 1) % LOCALES.length] ?? LOCALES[0]
  return (
    <button
      className="ghost seg"
      title={t('app.language.title')}
      onClick={() => {
        setLocale(next.id)
      }}
    >
      {next.label}
    </button>
  )
}
