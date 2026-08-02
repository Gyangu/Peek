import { Component, type ErrorInfo, type ReactNode } from 'react'
import { tStatic } from '../i18n'
import { Button } from '../ui/Button'

/**
 * The last line of defence around the whole window.
 *
 * The renderer is a mirror of state that lives in main, and React's rule for an
 * uncaught render error is to unmount the entire tree. Without a boundary that
 * turns any single bad value — a layout node that arrived as `undefined`, a view
 * kind nothing knows how to draw — into a permanently blank window: patches keep
 * arriving and are applied correctly, but nothing is left to render them, and
 * the only way out is the Reload menu item. Main meanwhile reports every command
 * as a success, so an MCP client cannot even tell that it killed the UI.
 *
 * So the boundary does two things, and deliberately no more:
 *
 * 1. it gives the user one button that is guaranteed to work. Reload rebuilds
 *    the renderer and pulls a fresh snapshot, and because no state of consequence
 *    lives here, nothing is lost by doing so;
 * 2. it puts the failure in the main-process log (`console.error` from the
 *    renderer is forwarded there, see main/index.ts) so a blank window leaves a
 *    stack trace behind instead of nothing.
 *
 * It does **not** try to repair the mirror or drop the offending subtree. A
 * renderer that guesses at half-broken state is how a display bug turns into a
 * wrong answer about somebody's database.
 */

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  /** The error text, or null while everything is fine. English: it is a stack trace, not a message to the user. */
  detail: string | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { detail: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { detail: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Not localized and not a toast: this is diagnostic output aimed at whoever
    // reads the log, and the toast layer is inside the tree that just died.
    console.error('[peek/renderer] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    const { detail } = this.state
    if (detail === null) return this.props.children

    // `tStatic` rather than `useT`: a class component has no hooks, and the
    // language switcher lives in the sidebar — which is inside the tree that just
    // stopped rendering — so there is no live language to follow any more.
    return (
      <div className="crash">
        <div className="crash-box">
          <div className="crash-title">{tStatic('app.crash.title')}</div>
          <div className="crash-body">{tStatic('app.crash.body')}</div>
          <pre className="crash-detail">{detail}</pre>
          <Button
            onClick={() => {
              location.reload()
            }}
          >
            {tStatic('app.crash.reload')}
          </Button>
        </div>
      </div>
    )
  }
}
