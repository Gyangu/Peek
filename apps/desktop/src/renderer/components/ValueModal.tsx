import { useCallback, useEffect, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactElement } from 'react'
import type { ColumnDef, ConnId, PeekedValue, ResultId, ValueRef } from '@peek/core'
import { VALUE_PEEK_MAX_BYTES, isTruncatedValue } from '@peek/core'
import { bridgeExtras } from '../bridge'
import { notify } from '../state/notifyStore'
import { formatBytes, fullValueText } from '../util/format'

export interface ValueModalProps {
  connId: ConnId
  resultId: ResultId | undefined
  row: number
  col: number
  column: ColumnDef
  value: unknown
  onClose: () => void
}

/**
 * 单值展开弹层。
 *
 * 大 value 在 chunk 里只有 4KB 预览（TruncatedValue），全量必须走 valuePeek。
 * 目前 Command Bus 里没有 valuePeek 命令（见交付说明的契约缺口），
 * 因此这里走桥的可选扩展；扩展不存在时只展示预览并明确告知。
 */
export function ValueModal(props: ValueModalProps): ReactElement {
  const { connId, resultId, row, col, column, value, onClose } = props
  const [peeked, setPeeked] = useState<PeekedValue | null>(null)
  const [loading, setLoading] = useState(false)

  const truncated = isTruncatedValue(value) ? value : null
  const canPeek = bridgeExtras.hasPeekValue()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const ref: ValueRef | null =
    truncated?.ref
    ?? (resultId ? { kind: 'resultCell', resultId, row, col } : null)

  const doPeek = useCallback(() => {
    if (!ref) return
    setLoading(true)
    bridgeExtras
      .peekValue(connId, ref, { offset: 0, length: VALUE_PEEK_MAX_BYTES })
      .then((v) => {
        setPeeked(v)
      })
      .catch((e: unknown) => {
        notify('error', '拉取全量值失败', e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [connId, ref])

  const body = peeked ? peekedText(peeked) : fullValueText(value)
  const size = truncated?.byteLength ?? peeked?.totalBytes

  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal" onMouseDown={stop}>
        <div className="modal-head">
          <span className="t mono">{column.name}</span>
          <span style={{ color: 'var(--fg-faint)' }}>
            {column.nativeType} · 第 {row + 1} 行
            {size !== undefined ? ` · ${formatBytes(size)}` : ''}
          </span>
          <span style={{ flex: 1 }} />
          {truncated && !peeked ? (
            <button
              className="primary"
              disabled={loading || !canPeek || !ref}
              onClick={doPeek}
              title={canPeek ? '通过 valuePeek 拉取全量' : '当前 preload 未提供 valuePeek 通道'}
            >
              {loading ? '拉取中…' : '拉取全量'}
            </button>
          ) : null}
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {truncated && !peeked ? (
            <div style={{ color: 'var(--warn)', marginBottom: 8 }}>
              仅显示 4KB 预览
              {canPeek ? '，点「拉取全量」取完整内容。' : '；当前 preload 未提供 valuePeek 通道，无法取全量。'}
            </div>
          ) : null}
          <div className="value-box">{body}</div>
        </div>
      </div>
    </div>
  )
}

function stop(e: ReactMouseEvent): void {
  e.stopPropagation()
}

function peekedText(v: PeekedValue): string {
  if (v.encoding === 'base64') {
    return `（base64，${formatBytes(v.byteLength)}${v.eof ? '' : '，未读完'}）\n${v.data}`
  }
  return v.data
}
