import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  PACKAGE_MAX_ROWS,
  parsePackageViewClientMessage,
  type PackageDataMessage,
  type PackageDataStatus,
  type PackageViewHostMessage,
  type PackageTheme,
  type PackageViewState,
} from '@peek/core'
import { dispatch } from '../state/dispatch'
import { notify } from '../state/notifyStore'
import { getCell, isPendingCell, setViewport } from '../state/resultCache'
import { useResult } from '../state/useResult'
import { useT } from '../i18n'

/* ==================================================================
 * The host side of a Tier C package view: an iframe, and one MessagePort.
 *
 * See `docs/design/2026-08-03-plugin-architecture.md` §2.6 (the origin) and
 * §2.6bis (the data path, which replaced the one §2.6 designed). The protocol
 * itself is `@peek/core/package-view-channel`, and it is the whole of what may cross.
 *
 * ## What this component is careful about, and what it deliberately is not
 *
 * It is careful about the *direction of trust*. Everything arriving from the
 * frame goes through `parsePackageViewClientMessage` before it is looked at, and the
 * only thing a valid message can do is patch its own view — through the same
 * `view.update` Command the user's own controls send, with the same validation
 * and the same audit trail. There is no path from here to another view, another
 * connection, or a statement.
 *
 * It is **not** careful about the frame being well-behaved: it may spin, it may
 * never send `ready`, it may send nonsense forever. Those are a package being
 * broken, not a package being dangerous, and the answers to them are the frame
 * budget and the kill switch (§2.6), not defensive code here.
 *
 * ## Why `sandbox` is not on the iframe
 *
 * `allow-scripts allow-same-origin` together is equivalent to no sandbox at all
 * — the combination is what lets a frame reach its own origin's storage and
 * therefore remove its own restrictions — and a package needs both. Writing the
 * attribute anyway would read like a boundary to the next person. **The boundary
 * is the origin**, and it is enforced by `registerSchemesAsPrivileged` and the
 * response CSP in `main/packages/protocol.ts`, both of which are outside the
 * frame's reach. Same conclusion VS Code reached for webviews.
 * ================================================================== */

export interface PackageFrameProps {
  view: PackageViewState
  /** The package whose UI to load; its origin is `peek-package://<packageId>`. */
  packageId: string
}

/**
 * peek has one theme today.
 *
 * Sent anyway, because the protocol declares the field and a package that reads
 * it must get a real answer rather than `undefined` — and because the day peek
 * grows a light theme, the packages that were written against this are the ones
 * that follow along for free.
 */
const THEME: PackageTheme = 'dark'

/**
 * How long silence from a frame counts as normal.
 *
 * Generous on purpose: this is a local file over a custom protocol, so a healthy
 * frame answers in single-digit milliseconds, and the only thing a longer wait
 * costs is how quickly a genuinely broken package is named. Short enough to fire
 * before anyone starts wondering, long enough that a machine under load never
 * sees it.
 */
const READY_TIMEOUT_MS = 3000

export function PackageFrame({ view, packageId }: PackageFrameProps): ReactElement {
  const t = useT()
  const [stalled, setStalled] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const portRef = useRef<MessagePort | null>(null)
  /**
   * Whether the frame has answered `ready`.
   *
   * A ref rather than state on purpose: it changes once, nothing renders
   * differently because of it, and making it state would re-render the whole
   * view — including the iframe's own subtree — at the exact moment the frame is
   * booting.
   */
  const readyRef = useRef(false)
  const snapshot = useResult(view.resultId)

  const origin = `peek-package://${packageId}`
  const src = `${origin}/index.html`

  const post = useCallback((message: PackageViewHostMessage) => {
    portRef.current?.postMessage(message)
  }, [])

  /**
   * Build the one bounded snapshot the frame gets (§2.6bis).
   *
   * Row-major and plain, not the columnar `ChunkFrame` the window uses: the
   * frame has no `resultCache`, no chunk assembler and no `vscroll`, so a
   * columnar frame would be a format it had to reimplement in order to read.
   *
   * A row containing a not-yet-arrived cell ends the prefix rather than being
   * sent with a hole in it. `PENDING_CELL` is a sentinel this side understands
   * and the frame does not, and the alternative — sending it as `null` — is
   * indistinguishable from a real null once it is over there. `truncated` is
   * what says the prefix is a prefix, and it covers both reasons for one:
   * the `PACKAGE_MAX_ROWS` cap and rows that have not landed yet.
   */
  const buildData = useCallback((): PackageDataMessage => {
    const status: PackageDataStatus =
      snapshot.error !== null
        ? 'error'
        : snapshot.status === 'running'
          ? 'loading'
          : snapshot.status === 'done'
            ? 'done'
            : snapshot.status === 'error'
              ? 'error'
              : 'idle'

    const columns = (snapshot.schema ?? []).map((col) => col.name)
    const rows: unknown[][] = []
    const ceiling = Math.min(snapshot.rowCount, PACKAGE_MAX_ROWS)
    outer: for (let r = 0; r < ceiling; r++) {
      const row: unknown[] = []
      for (let c = 0; c < columns.length; c++) {
        const cell = getCell(view.resultId, r, c)
        if (isPendingCell(cell)) break outer
        row.push(cell)
      }
      rows.push(row)
    }

    return {
      t: 'data',
      status,
      columns,
      rows,
      rowCount: snapshot.rowCount,
      truncated: rows.length < snapshot.rowCount,
      ...(snapshot.error === null ? {} : { error: snapshot.error.message }),
    }
  }, [snapshot, view.resultId])

  /**
   * What the port handler reads, kept current without being a dependency of it.
   *
   * The handler needs the *latest* view and the latest snapshot builder, but
   * making those effect dependencies would tear the port down and redo the
   * handshake on every patch — that is, on every interaction the package's own UI
   * performs. A ref updated on each render is the standard way out, and the
   * reason it is safe here is that nothing in the handler runs during render.
   */
  const latest = useRef({ view, buildData, t })
  latest.current = { view, buildData, t }

  /**
   * Hand the frame its port, once per document.
   *
   * The handshake runs frame-last — port over `window.postMessage`, then the
   * frame answers `ready`, then the host sends `init`. The reason is in
   * `package-view-channel.ts`: `load` is the earliest moment the frame is guaranteed
   * to have installed a listener, and anything sent before that is dropped with
   * no trace on either side.
   *
   * Re-runs on every `load`, which is what makes a reloaded or crashed-and-
   * restored frame recover rather than sit inert with a dead port.
   */
  useEffect(() => {
    const frame = frameRef.current
    if (frame === null) return

    const handleLoad = (): void => {
      portRef.current?.close()
      readyRef.current = false

      const channel = new MessageChannel()
      portRef.current = channel.port1
      channel.port1.onmessage = (event: MessageEvent): void => {
        const message = parsePackageViewClientMessage(event.data)
        // Dropped, not thrown, and not surfaced: a frame that sends nonsense is
        // a broken package, and taking the window down — or filling the error
        // centre with one entry per frame — is the wrong blast radius for it.
        if (message === null) return
        const current = latest.current
        switch (message.t) {
          case 'ready':
            readyRef.current = true
            setStalled(false)
            post({
              t: 'init',
              viewId: current.view.id,
              packageKind: current.view.packageKind,
              state: current.view.state,
              locale: navigator.language,
              theme: THEME,
            })
            post(current.buildData())
            return
          case 'patch':
            // The same Command the built-in controls send. A package therefore
            // cannot reach anything a user could not, and its changes appear in
            // the command log like everyone else's.
            void dispatch('view.update', {
              viewId: current.view.id,
              patch: {
                kind: 'package',
                ...(message.state === undefined ? {} : { state: message.state }),
                ...(message.title === undefined ? {} : { title: message.title }),
              },
            })
            return
          case 'error':
            // Surfaced, unlike a malformed message: this one the package author
            // chose to send, and a frame with no console anyone opens has no
            // other way to be heard.
            notify(
              'error',
              current.t('view.packageError', { kind: current.view.packageKind }),
              message.message,
            )
            return
        }
      }

      // `origin` rather than `'*'`: the second argument is what the browser
      // checks the *receiver* against, so a `'*'` here would hand the port to
      // whatever document happened to be in the frame — including one a
      // navigation put there.
      frame.contentWindow?.postMessage({ t: 'peek-package-port' }, origin, [channel.port2])
    }

    frame.addEventListener('load', handleLoad)
    return () => {
      frame.removeEventListener('load', handleLoad)
      portRef.current?.close()
      portRef.current = null
      readyRef.current = false
    }
    // Keyed on what identifies the *frame* and nothing else. Everything mutable
    // the handler reads comes from `latest`, for the reason recorded there.
  }, [view.id, origin, src, post])

  /** State changes reach the frame as `state`; it holds no copy of its own. */
  useEffect(() => {
    if (readyRef.current) post({ t: 'state', state: view.state })
  }, [view.state, post])

  /** Every new version of the result is a new bounded snapshot. */
  useEffect(() => {
    if (readyRef.current) post(buildData())
  }, [buildData, post])

  /**
   * A frame that never says `ready` must not be a blank rectangle.
   *
   * The two ways to get one are indistinguishable from out here — the UI was
   * never built (`out/packages/<id>/ui/index.html` is a 404, and the frame that
   * loads instead has no script to answer with), or the package's own boot threw
   * before it could reach the port. Both are the app failing to show something it
   * said it would, and both are actionable by the same first step, so they share
   * one message rather than being guessed between.
   *
   * A timer rather than an `error` event on the iframe: a 404 from
   * `protocol.handle` is a *successful* navigation to an error body, so `error`
   * never fires. Silence on the port is the only signal that covers both cases.
   */
  useEffect(() => {
    setStalled(false)
    const timer = window.setTimeout(() => {
      if (!readyRef.current) setStalled(true)
    }, READY_TIMEOUT_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [view.id, src])

  /**
   * Report a viewport, or the stream never releases.
   *
   * Backpressure is viewport-driven (`resultCache.setViewport`), and a result
   * nobody reports a viewport for is a result that runs flat out — the
   * orphaned-stream case `beginResult` in main documents. The range is exactly
   * what this view can consume, and `atBottom: false` because a package view is
   * never asking for more than its cap.
   */
  useEffect(() => {
    const resultId = view.resultId
    if (resultId === undefined) return
    setViewport(resultId, 0, PACKAGE_MAX_ROWS - 1, false)
    return () => {
      // The explicit final report `setViewport` asks every consumer for: without
      // it the cache goes on believing someone is reading this result.
      setViewport(resultId, 0, 0, false)
    }
  }, [view.resultId])

  return (
    /* The frame fills the panel and draws its own everything. peek contributes
       no chrome around it on purpose: a package that is given a header it does
       not control ends up drawing a second one inside, and the two disagree
       about which view is which. See
       docs/design/2026-08-03-plugin-architecture.md §2.6. */
    <div className="relative flex min-h-0 flex-1">
      <iframe
        ref={frameRef}
        /* `bg-bg-1` because the frame's own document paints its background, and
           without this the iframe's default white flashes through for one frame
           on a dark window. `scheme-dark` is all peek can say about the inside:
           it is cross-origin, so every visual decision in there is the
           package's, and this element only decides how much room it gets. */
        className="flex-1 border-0 bg-bg-1 scheme-dark"
        src={src}
        title={view.title ?? view.packageKind}
        // No `allow`, so every permission-policy-gated feature (camera, geolocation,
        // clipboard-read, …) is denied. The default is already deny for a
        // cross-origin frame; stating it means a future default cannot loosen it.
        allow=""
        referrerPolicy="no-referrer"
      />
      {stalled && (
        /* Shown only when the frame never answered `ready` — see
           READY_TIMEOUT_MS. `absolute inset-0` covers the frame rather than
           replacing it, so a package that recovers late is still visible
           underneath rather than having been unmounted.

           `text-center` as well as the flex centring: the flex pair places the
           block, and this is what centres the second line once the sentence
           wraps. It was the last rule in `app.css` held there by the type
           scale's usage scan rejecting alignment classes, which it no longer
           does. */
        <div
          className="absolute inset-0 flex items-center justify-center bg-bg-1 px-block text-center text-fg-faint"
          role="status"
        >
          {t('view.packageUnbuilt', { kind: view.packageKind })}
        </div>
      )}
    </div>
  )
}
