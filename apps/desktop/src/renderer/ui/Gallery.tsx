import { useState } from 'react'
import type { ReactElement } from 'react'

import { Button } from './Button'
import { CONTROL_SIZE_NAMES, BUTTON_VARIANTS, BUTTON_VARIANT_NAMES } from './spec'

/**
 * Every control the spec defines, on one screen.
 *
 * Two readers, one artefact:
 *
 * - **A person** gets an answer to "what do we have and what does it look like"
 *   without reading a stylesheet — and, because each row prints its `intent`
 *   straight out of `spec.ts`, an answer to "which one should I use" as well.
 *   The spec's prose is not filed away in a doc; it is on screen next to the
 *   pixels it describes, so the two cannot quietly disagree.
 *
 * - **An agent** gets a surface it can screenshot. This is not a nicety. An
 *   agent editing this codebase never sees its own output: it writes CSS, the
 *   tests pass, and it has no idea whether the result is right. The one time
 *   this was checked during the legibility work, a number the design doc stated
 *   with confidence (25.4px) turned out to measure 23.9px in the built app.
 *   Without a page like this there is nothing to point a screenshot at.
 *
 * Dev-only, mounted at the bottom of the settings dialog's About section, and
 * excluded from production by the `import.meta.env.DEV` guard at the call site.
 * Its copy is deliberately untranslated: it documents an English-named API for
 * whoever is editing the code, and putting it through the catalogues would
 * imply it ships.
 *
 * Design record: docs/design/2026-08-02-control-spec.md §2.7
 */
export function Gallery(): ReactElement {
  const [pressed, setPressed] = useState<string>('—')

  return (
    <div className="gal">
      <p className="gal-note">
        Hover, press and tab through these: <code>:hover</code>, <code>:active</code> and{' '}
        <code>:focus-visible</code> cannot be shown at rest, and the last two did not exist at all
        before the control layer. Last pressed: <span className="mono">{pressed}</span>
      </p>

      {BUTTON_VARIANT_NAMES.map((variant) => (
        <section className="gal-row" key={variant}>
          <header className="gal-head">
            <code className="gal-name">{variant}</code>
            <span className="gal-intent">{BUTTON_VARIANTS[variant].intent}</span>
            {BUTTON_VARIANTS[variant].rule === null ? null : (
              <span className="gal-rule">{BUTTON_VARIANTS[variant].rule}</span>
            )}
          </header>

          <div className="gal-cells">
            {CONTROL_SIZE_NAMES.map((size) => (
              <div className="gal-cell" key={size}>
                <Button variant={variant} size={size} onClick={() => setPressed(`${variant} / ${size}`)}>
                  {size === 'md' ? 'Action' : 'Inline'}
                </Button>
                <Button variant={variant} size={size} disabled>
                  Disabled
                </Button>
                <Button
                  variant={variant}
                  size={size}
                  icon
                  label={`${variant} icon, ${size}`}
                  onClick={() => setPressed(`${variant} / ${size} / icon`)}
                >
                  ✕
                </Button>
                <span className="gal-size">{size}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
