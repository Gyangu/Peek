import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'
import type { DriverId } from '@peek/core'

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

function dialectOf(driverId: DriverId): typeof StandardSQL {
  switch (driverId) {
    case 'postgres':
      return PostgreSQL
    case 'mysql':
      return MySQL
    case 'sqlite':
      return SQLite
    default:
      return StandardSQL
  }
}
