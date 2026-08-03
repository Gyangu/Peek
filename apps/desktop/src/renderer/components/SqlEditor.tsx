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

  return <div className="editor-wrap" ref={hostRef} style={{ height }} />
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
