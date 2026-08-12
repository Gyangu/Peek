/**
 * The page the render probe measures.
 *
 * This file is deliberately thin: it mounts **the product's own components**
 * into a document whose only stylesheet is the **built artifact**, and adds
 * nothing that paints. Everything the probe asserts is therefore a statement
 * about the shipped app, not about a mock of it.
 *
 * Three rules this file lives by, each of which has a way of going wrong:
 *
 * 1. **No class names of its own.** It lives under `scripts/`, which is outside
 *    the `@source './'` scan in `styles.css`, so any class invented here would
 *    compile to nothing and silently lay out wrong — and any class that *did*
 *    reach the scanner would put a rule into the shipped artifact that only a
 *    probe wears. Layout scaffolding is written as inline `style`, which needs
 *    no compiler. The class strings that do appear come from the product's own
 *    exported constants (`CONN_DOT`) or from the components themselves.
 * 2. **No colours.** The colour sweep in `page-checks.js` walks every element on the
 *    page and holds it to the palette. Scaffolding that painted would either
 *    fail that check or force an exemption, and an exemption for the harness is
 *    how a fence starts covering less than it says.
 * 3. **One pane per page load.** Two dialogs are two `position: fixed` masks;
 *    mounted together they overlap and the second one's geometry is measured
 *    through the first. The probe loads this page once per pane instead.
 *
 * Rendered client-side rather than as static markup: effects run, refs resolve,
 * and an effect that writes `element.style` is exactly the second channel this
 * probe exists to see.
 */

import { createRoot } from 'react-dom/client'
import type { ReactElement } from 'react'

// Side-effect import, and it has to come first: the connect dialog draws the
// fields of whatever is installed, and nothing is installed in a page with no
// preload behind it (`drivers/installed.ts`). This is the same stand-in the
// suite uses — the five in-repo packages, as the loader would have parsed them —
// so what the probe measures is still the product's own form for a real driver
// rather than a fixture's idea of one.
import '../../src/drivers/__tests__/in-repo-registry'
import { ConnectDialog } from '../../src/renderer/components/ConnectDialog'
import { ConsentDialog } from '../../src/renderer/components/context-actions/ConsentDialog'
import { CONN_DOT } from '../../src/renderer/components/shellClasses'
import { isLocale, setLocale } from '../../src/renderer/i18n'
import { Button } from '../../src/renderer/ui/Button'
import { Gallery } from '../../src/renderer/ui/Gallery'
import { BUTTON_VARIANT_NAMES } from '../../src/renderer/ui/spec'

declare global {
  interface Window {
    /** Set once the pane has mounted and painted; the probe waits on it. */
    __probeReady?: string
    /** Set instead if mounting threw; the probe fails on it rather than measuring a blank page. */
    __probeError?: string
  }
}

function noop(): void {
  /* the probe never answers a dialog; it measures one */
}

/**
 * Every button variant, each in a wrapper the probe can address.
 *
 * `data-probe-variant` is on a wrapper rather than on the control: `Button`
 * spreads its rest props onto the element, and a probe attribute riding on the
 * control itself would be one more thing the control has to carry. The wrapper
 * is `display: contents` so it adds no box of its own to measure through.
 */
function VariantRow(): ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', padding: '14px' }}>
      {BUTTON_VARIANT_NAMES.map((variant) => (
        <span key={variant} data-probe-variant={variant} style={{ display: 'contents' }}>
          <Button variant={variant}>Aa</Button>
        </span>
      ))}
    </div>
  )
}

/**
 * The gallery pane: every control the spec defines, plus the connection dot in
 * its one animated state.
 *
 * The dot is here because the reduced-motion check needs something that animates
 * at rest, and this is the app's only such element outside the chat panel. It is
 * spelled with the product's own `CONN_DOT.connecting`, so a rename over there
 * arrives here as a compile error rather than as a check that silently measures
 * an element with no animation.
 */
function GalleryPane(): ReactElement {
  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <VariantRow />
      <div style={{ padding: '14px' }}>
        <span data-probe-dot="connecting" className={CONN_DOT.connecting} />
      </div>
      <div style={{ padding: '14px' }}>
        <Gallery />
      </div>
    </div>
  )
}

/**
 * The connect dialog in **fields** mode — the only pane in this app that puts a
 * native checkbox on screen, and therefore the only place the user agent's own
 * `accent-color` can be photographed.
 *
 * The driver is `redis` for one measured reason. The dialog's opening mode is
 * `manifest.connectForm.modes[0]`, and `connectModeFor()` falls back to that
 * same value when the seeded config carries no `url` — so for postgres
 * (`['url','fields']`) there is **no** `initial` that opens the fields form, and
 * its `ssl` checkbox stays unmounted. Measured: seeding a host/port postgres
 * config still rendered 34 elements and zero checkboxes. redis declares
 * `['fields','url']`, so it opens on the form that carries `tls`.
 *
 * That the pane also brings a `number` and a `password` input with it is a
 * bonus: they are UA-painted too, and the spin buttons and reveal control are
 * surfaces no stylesheet in this repo can reach.
 *
 * The alternative — writing an `<input type="checkbox">` here — would measure a
 * control the app does not ship, which is the one thing this fixture must not
 * do.
 */
function ConnectFieldsPane(): ReactElement {
  return (
    <ConnectDialog
      onClose={noop}
      initial={{
        id: 'probe',
        driverId: 'redis',
        label: 'probe',
        config: { host: 'localhost', port: 6379 },
        hasSecret: false,
      }}
    />
  )
}

function paneFor(name: string): ReactElement | null {
  switch (name) {
    case 'gallery':
      return <GalleryPane />
    case 'connect':
      return <ConnectDialog onClose={noop} />
    case 'connect-fields':
      return <ConnectFieldsPane />
    case 'consent':
      return <ConsentDialog onAccept={noop} onCancel={noop} />
    default:
      return null
  }
}

function mount(): void {
  const params = new URLSearchParams(window.location.search)
  const name = params.get('pane') ?? ''
  const locale = params.get('locale')
  // Before the first render, for the reason `main.tsx` states: a pane that
  // painted English and then swapped would be measured mid-swap.
  if (locale !== null) {
    if (!isLocale(locale)) throw new Error(`unknown locale ${locale}`)
    setLocale(locale)
  }
  const element = paneFor(name)
  if (element === null) throw new Error(`unknown pane ${JSON.stringify(name)}`)

  const host = document.getElementById('root')
  if (host === null) throw new Error('mount point #root not found')
  createRoot(host).render(element)

  // Two frames: one for React to commit, one for the style and layout that
  // commit produced. Reading on the first frame is how a probe measures a tree
  // that has mounted but not yet been laid out.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (host.childElementCount === 0) {
        window.__probeError = `pane ${name} mounted nothing`
        return
      }
      window.__probeReady = name
    })
  })
}

try {
  mount()
} catch (err) {
  window.__probeError = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
}
