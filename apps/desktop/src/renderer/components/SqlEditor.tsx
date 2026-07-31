import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { MySQL, PostgreSQL, SQLite, StandardSQL, sql } from '@codemirror/lang-sql'
import { basicSetup } from 'codemirror'
import type { DriverId } from '@peek/core'

export interface SqlEditorProps {
  /** 权威文本，来自 Workspace 镜像 */
  value: string
  driverId: DriverId
  /** Cmd/Ctrl+Enter 执行 */
  onRun: (text: string) => void
  /** 失焦时把编辑缓冲提交回 main（view.update） */
  onCommit: (text: string) => void
  /** 编辑区高度（像素），由 QueryView 的分隔条控制 */
  height: number
}

/**
 * CodeMirror 6 SQL 编辑器。
 *
 * 关于"不做本地乐观更新"：编辑器里的字符是**未提交的输入缓冲**，
 * 不是 Workspace 状态。真正的状态变更只在执行（query.run 带 text）
 * 或失焦（view.update）时才发出去。外部（比如 MCP）改了 text，
 * 这里会把新文本灌回编辑器。
 */
export function SqlEditor(props: SqlEditorProps): ReactElement {
  const { value, driverId, onRun, onCommit, height } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // 回调放 ref 里，避免每次渲染重建整套扩展
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
    // 方言与编辑器实例绑定；文本的后续同步走下面那个 effect
  }, [driverId])

  // 外部改了权威文本（MCP / 其他视图）→ 灌回编辑器
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
