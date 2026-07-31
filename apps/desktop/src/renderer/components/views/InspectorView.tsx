import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { InspectorViewState, KeyValueResult, PeekedValue, ValueRef } from '@peek/core'
import { VALUE_PEEK_MAX_BYTES } from '@peek/core'
import { bridgeExtras } from '../../bridge'
import { tStatic, useT, type TFunction } from '../../i18n'
import { notify } from '../../state/notifyStore'
import { getCell, isPendingCell } from '../../state/resultCache'
import { useConnection } from '../../state/workspaceStore'
import { formatBytes, fullValueText } from '../../util/format'
import { ViewError } from '../ViewError'

/** Single value / single row inspector. */
export function InspectorView({ view }: { view: InspectorViewState }): ReactElement {
  const { connId, ref } = view
  const t = useT()
  const conn = useConnection(connId)
  const [peeked, setPeeked] = useState<PeekedValue | null>(null)
  const [kv, setKv] = useState<KeyValueResult | null>(null)
  const [loading, setLoading] = useState(false)

  const refKey = JSON.stringify(ref)
  useEffect(() => {
    setPeeked(null)
    setKv(null)
  }, [refKey])

  // A resultCell hits the local columnar cache directly, no round trip needed
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
      // tStatic, not `t`: a toast is worded once, when it is raised (see notifyStore).
      notify('error', tStatic('inspector.fetchFailed'), e instanceof Error ? e.message : String(e))
    }).finally(() => {
      setLoading(false)
    })
  }, [connId, refKey])

  const canFetch = bridgeExtras.hasPeekValue()

  let body: string
  if (peeked) body = peeked.encoding === 'base64' ? `(base64)\n${peeked.data}` : peeked.data
  else if (kv) body = fullValueText(kv.value)
  else if (hasLocal) body = fullValueText(local)
  else body = t('inspector.notFetched')

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? connId}</span>
        <span className="sep" />
        {/* `ref.kind` is the addressing scheme's own name — an identifier. */}
        <span className="mono">{ref.kind}</span>
        <span className="sep" />
        <button className="ghost" disabled={loading || !canFetch} onClick={fetchFull}>
          {loading ? t('inspector.fetching') : t('inspector.fetchFull')}
        </button>
        <span className="grow" />
        {!canFetch ? (
          <span style={{ color: 'var(--warn)' }}>{t('inspector.peekUnavailable')}</span>
        ) : null}
      </div>

      <ViewError error={view.error} />

      <div className="inspector">
        <div className="kv-grid">
          {refRows(t, ref).map(([k, v]) => (
            <ReadonlyRow key={k} k={k} v={v} />
          ))}
          {kv ? <ReadonlyRow k={t('inspector.field.type')} v={kv.type} /> : null}
          {kv?.ttlMs !== undefined ? (
            <ReadonlyRow k={t('inspector.field.ttl')} v={`${kv.ttlMs} ms`} />
          ) : null}
          {kv?.size !== undefined ? (
            <ReadonlyRow k={t('inspector.field.elements')} v={String(kv.size)} />
          ) : null}
          {peeked?.contentType ? (
            <ReadonlyRow k={t('inspector.field.contentType')} v={peeked.contentType} />
          ) : null}
          {peeked ? (
            <ReadonlyRow k={t('inspector.field.bytesFetched')} v={formatBytes(peeked.byteLength)} />
          ) : null}
          {peeked?.totalBytes !== undefined ? (
            <ReadonlyRow k={t('inspector.field.bytesTotal')} v={formatBytes(peeked.totalBytes)} />
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

/**
 * Rows describing what is being inspected.
 *
 * `key`, `db`, `collection` and `point` stay untranslated: they are the field
 * names of the addressing scheme itself, and a user comparing this panel against
 * a Redis or Qdrant response needs them to read the same on both sides.
 */
function refRows(t: TFunction, ref: ValueRef): [string, string][] {
  switch (ref.kind) {
    case 'resultCell':
      return [
        [t('inspector.field.result'), ref.resultId],
        [t('inspector.field.row'), String(ref.row + 1)],
        [t('inspector.field.column'), String(ref.col)],
      ]
    case 'relationCell':
      return [
        [t('inspector.field.collection'), `${ref.collection.schema}.${ref.collection.name}`],
        [t('inspector.field.primaryKey'), JSON.stringify(ref.pk)],
        [t('inspector.field.column'), ref.column],
      ]
    case 'redisValue':
      return [
        ['key', ref.key],
        ...(ref.db === undefined ? [] : ([['db', String(ref.db)]] as [string, string][])),
        ...(ref.path === undefined
          ? []
          : ([[t('inspector.field.path'), ref.path]] as [string, string][])),
      ]
    case 'qdrantPoint':
      return [
        ['collection', ref.collection],
        ['point', String(ref.pointId)],
        [t('inspector.field.field'), ref.field],
      ]
  }
}
