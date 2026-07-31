import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { InspectorViewState, KeyValueResult, PeekedValue, ValueRef } from '@peek/core'
import { VALUE_PEEK_MAX_BYTES } from '@peek/core'
import { bridgeExtras } from '../../bridge'
import { notify } from '../../state/notifyStore'
import { getCell, isPendingCell } from '../../state/resultCache'
import { useConnection } from '../../state/workspaceStore'
import { formatBytes, fullValueText } from '../../util/format'
import { ViewError } from '../ViewError'

/** 单值 / 单行检查器 */
export function InspectorView({ view }: { view: InspectorViewState }): ReactElement {
  const { connId, ref } = view
  const conn = useConnection(connId)
  const [peeked, setPeeked] = useState<PeekedValue | null>(null)
  const [kv, setKv] = useState<KeyValueResult | null>(null)
  const [loading, setLoading] = useState(false)

  const refKey = JSON.stringify(ref)
  useEffect(() => {
    setPeeked(null)
    setKv(null)
  }, [refKey])

  // resultCell 直接命中本地列式缓存，不用回源
  const local =
    ref.kind === 'resultCell' ? getCell(ref.resultId, ref.row, ref.col) : undefined
  const hasLocal = local !== undefined && !isPendingCell(local)

  const fetchFull = useCallback(() => {
    setLoading(true)
    const isKv = ref.kind === 'redisValue'
    const p = isKv
      ? bridgeExtras.getKeyValue(connId, ref).then((v) => {
          setKv(v)
        })
      : bridgeExtras
          .peekValue(connId, ref, { offset: 0, length: VALUE_PEEK_MAX_BYTES })
          .then((v) => {
            setPeeked(v)
          })
    p.catch((e: unknown) => {
      notify('error', '读取值失败', e instanceof Error ? e.message : String(e))
    }).finally(() => {
      setLoading(false)
    })
  }, [connId, refKey])

  const canFetch = bridgeExtras.hasPeekValue()

  let body: string
  if (peeked) body = peeked.encoding === 'base64' ? `（base64）\n${peeked.data}` : peeked.data
  else if (kv) body = fullValueText(kv.value)
  else if (hasLocal) body = fullValueText(local)
  else body = '（尚未取值）'

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? connId}</span>
        <span className="sep" />
        <span className="mono">{ref.kind}</span>
        <span className="sep" />
        <button className="ghost" disabled={loading || !canFetch} onClick={fetchFull}>
          {loading ? '读取中…' : '取全量'}
        </button>
        <span className="grow" />
        {!canFetch ? (
          <span style={{ color: 'var(--warn)' }}>preload 未提供 valuePeek 通道</span>
        ) : null}
      </div>

      <ViewError error={view.error} />

      <div className="inspector">
        <div className="kv-grid">
          {refRows(ref).map(([k, v]) => (
            <ReadonlyRow key={k} k={k} v={v} />
          ))}
          {kv ? <ReadonlyRow k="类型" v={kv.type} /> : null}
          {kv?.ttlMs !== undefined ? <ReadonlyRow k="TTL" v={`${kv.ttlMs} ms`} /> : null}
          {kv?.size !== undefined ? <ReadonlyRow k="元素数" v={String(kv.size)} /> : null}
          {peeked?.contentType ? <ReadonlyRow k="内容类型" v={peeked.contentType} /> : null}
          {peeked ? <ReadonlyRow k="本次字节" v={formatBytes(peeked.byteLength)} /> : null}
          {peeked?.totalBytes !== undefined ? (
            <ReadonlyRow k="全量字节" v={formatBytes(peeked.totalBytes)} />
          ) : null}
        </div>
        <div className="value-box">{body}</div>
      </div>
    </>
  )
}

function ReadonlyRow({ k, v }: { k: string; v: string }): ReactElement {
  return (
    <>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </>
  )
}

function refRows(ref: ValueRef): [string, string][] {
  switch (ref.kind) {
    case 'resultCell':
      return [
        ['结果集', ref.resultId],
        ['行', String(ref.row + 1)],
        ['列', String(ref.col)],
      ]
    case 'relationCell':
      return [
        ['集合', `${ref.collection.schema}.${ref.collection.name}`],
        ['主键', JSON.stringify(ref.pk)],
        ['列', ref.column],
      ]
    case 'redisValue':
      return [
        ['key', ref.key],
        ...(ref.db === undefined ? [] : ([['db', String(ref.db)]] as [string, string][])),
        ...(ref.path === undefined ? [] : ([['路径', ref.path]] as [string, string][])),
      ]
    case 'qdrantPoint':
      return [
        ['collection', ref.collection],
        ['point', String(ref.pointId)],
        ['字段', ref.field],
      ]
  }
}
