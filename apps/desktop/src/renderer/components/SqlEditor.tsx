import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'
import type { DriverId, SqlDialectId } from '@peek/core'
import { lookupManifest } from '../../drivers/manifests'

export interface SqlEditorProps {
  /** The authoritative text, from the Workspace mirror. */
  value: string
  driverId: DriverId
  /** Cmd/Ctrl+Enter runs the statement. */
  onRun: (text: string) => void
  /** On blur, commit the edit buffer back to main (view.update). */
  onCommit: (text: string) => void
  /** Editor height in pixels, controlled by the QueryView divider. */
  height: number
}

/**
 * The dark theme, as a CodeMirror extension rather than as CSS rules.
 *
 * These thirteen rules used to live unlayered at the bottom of `styles.css`,
 * where they were the one block Tailwind could not own: Tailwind puts every
 * utility inside `@layer`, and an unlayered rule always beats a layered one, so
 * CodeMirror's own runtime-injected rules — two-level selectors like
 * `.ͼ1 .cm-content`, injected by style-mod into `document.head` — outrank
 * anything we could write as a utility. Hand-written unlayered CSS was the
 * workaround; `EditorView.theme` is the actual mechanism. It goes through the
 * same style-mod pipeline as CodeMirror's own rules, so it lands in the same
 * unlayered bucket at the same specificity, and the layer fight disappears
 * instead of being won.
 *
 * The values still come from the palette. `var(--color-*)` resolves at use
 * time against whatever `:root` says, so the theme tracks the tokens exactly as
 * the CSS did — this is a move, not a re-tune.
 *
 * Selector syntax is style-mod's, not CSS's: `&` is the theme class on the
 * editor's own element, and a bare `.cm-x` is a descendant of it.
 */
const PEEK_THEME = EditorView.theme(
  {
    '&': {
      background: 'var(--color-bg)',
      color: 'var(--color-fg)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-body)',
      // Sizing, moved off `.editor-wrap .cm-editor` in styles.css. That rule
      // needed the wrapper as an ancestor for the only reason its own comment
      // gave — `.cm-editor` is built by CodeMirror, so there was nowhere to hang
      // a utility on it. Here there is: this *is* the hook that was missing, and
      // the descendant selector it was standing in for is no longer needed.
      width: '100%',
      height: '100%',
      userSelect: 'text',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.5',
    },
    '.cm-gutters': {
      background: 'var(--color-bg-1)',
      color: 'var(--color-fg-faint)',
      borderRight: '1px solid var(--color-border)',
    },
    '.cm-activeLineGutter': {
      background: 'var(--color-bg-2)',
      color: 'var(--color-fg-dim)',
    },
    // The tint on the line the cursor is in: --color-bg-1 at 20%, so it reads as
    // a lift off whatever the editor's own background happens to be rather than
    // as a fifth surface. Written as a mix rather than as a token of its own
    // because a translucent tint has no colour until it lands on something.
    '.cm-activeLine': {
      background: 'color-mix(in srgb, var(--color-bg-1) 20%, transparent)',
    },
    // There is no `.cm-content { caretColor }` here, and that is a deletion
    // rather than an omission. `styles.css` carried one for as long as the theme
    // existed and it never painted a pixel: `basicSetup` pulls in
    // `drawSelection`, which hides the native caret so it can draw its own, and
    // it does so with `caret-color: transparent !important` on the same element
    // at the same specificity. Unlayered against unlayered, the marker wins and
    // nothing without one can reach that property. Measured, not reasoned: the
    // old declaration was re-added at the end of the document during the move
    // and the computed value stayed `rgba(0, 0, 0, 0)`.
    //
    // The caret you actually see is the next rule. CodeMirror draws it as a
    // bordered element, so the colour that matters is a border colour.
    '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
    // `!important` is carried over verbatim. CodeMirror's own selection rules
    // arrive through the same injector, so which one wins is a question of
    // injection order rather than of specificity — the flag is what made this
    // deterministic as CSS, and it is what keeps it deterministic here.
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      background: 'var(--color-bg-sel) !important',
    },
    '.cm-tooltip': {
      background: 'var(--color-bg-2)',
      border: '1px solid var(--color-border-strong)',
      color: 'var(--color-fg)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      background: 'var(--color-accent-dim)',
    },
    '.cm-panels': {
      background: 'var(--color-bg-2)',
      color: 'var(--color-fg)',
    },
  },
  { dark: true },
)

/**
 * The CodeMirror 6 SQL editor.
 *
 * On "no optimistic local updates": the characters in the editor are an
 * **uncommitted input buffer**, not Workspace state. A real state change is only
 * sent on run (query.run carries the text) or on blur (view.update). When the
 * text changes from the outside — MCP, say — the new text is pushed back into
 * the editor here.
 */
export function SqlEditor(props: SqlEditorProps): ReactElement {
  const { value, driverId, onRun, onCommit, height } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Callbacks live in refs so a render does not rebuild the whole extension set
  const runRef = useRef(onRun)
  const commitRef = useRef(onCommit)
  runRef.current = onRun
  commitRef.current = onCommit

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: (v) => {
            runRef.current(v.state.doc.toString())
            return true
          },
        },
      ]),
    )

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          runKeymap,
          basicSetup,
          sql({ dialect: dialectOf(driverId), upperCaseKeywords: false }),
          PEEK_THEME,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            blur: (_e, v) => {
              commitRef.current(v.state.doc.toString())
              return false
            },
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // The dialect is bound to the editor instance; text keeps syncing in the effect below
  }, [driverId])

  // The authoritative text changed elsewhere (MCP, another view) → push it in
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value])

  return (
    <div
      className="flex flex-none min-h-15 overflow-hidden border-b border-border"
      ref={hostRef}
      style={{ height }}
    />
  )
}

/**
 * Which grammar to highlight with.
 *
 * The driver names its own dialect (`DriverManifest.sqlDialect`); this table
 * turns that name into a CodeMirror object. The split is the point: the grammar
 * a database speaks is a fact about the database, but `@codemirror/lang-sql` is
 * a fact about this editor, and importing it into a driver package would put a
 * syntax highlighter in the driver host process.
 *
 * A driver with no `sqlDialect` has no SQL surface at all (redis, qdrant), which
 * is not the same as wanting the standard one — but the editor is only ever
 * mounted for a `query` view, and a query view can only exist on a driver with
 * `tabularQuery`. `StandardSQL` is therefore the answer to a question that is
 * not asked, kept because a total function has no failure mode to handle.
 */
const CODEMIRROR_DIALECT: Readonly<Record<SqlDialectId, typeof StandardSQL>> = {
  postgres: PostgreSQL,
  mysql: MySQL,
  sqlite: SQLite,
  standard: StandardSQL,
}

function dialectOf(driverId: DriverId): typeof StandardSQL {
  const dialect = lookupManifest(driverId)?.sqlDialect
  return dialect === undefined ? StandardSQL : CODEMIRROR_DIALECT[dialect]
}
