import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  ConnId,
  InspectorViewState,
  KeyValueElement,
  KeyValuePayload,
  KeyValueResult,
  KeyValueWindow,
  PeekedValue,
  ValueRef,
} from '@peek/core'
import { DEFAULT_KEY_VALUE_ELEMENTS, VALUE_PEEK_MAX_BYTES } from '@peek/core'
import { bridgeExtras } from '../../bridge'
import { tStatic, useT, type TFunction } from '../../i18n'
import { connHas } from '../../state/capabilities'
import { notify } from '../../state/notifyStore'
import { getCell, isPendingCell } from '../../state/resultCache'
import { useConnection } from '../../state/workspaceStore'
import { formatBytes, fullValueText } from '../../util/format'
import { ViewError } from '../ViewError'
import { nextKeyWindow, windowSize } from './keyWindow'

/**
 * Single value / single row inspector.
 *
 * Two quite different jobs behind one view kind, told apart by the ref and by
 * what the connection can do:
 *
 * - a **cell** (result cell, relational cell, qdrant point field) is a blob of
 *   bytes: fetched on demand through valuePeek and shown as text;
 * - a **key** in a keyValue store is a data structure. A hash is not a string
 *   that happens to contain fields, and rendering it as one throws away exactly
 *   what the user opened the inspector for. `KeyValuePayload` is a discriminated
 *   union so that this component can switch on `shape` and draw the right thing,
 *   and it is read eagerly because it *is* the view.
 */
export function InspectorView({ view }: { view: InspectorViewState }): ReactElement {
  const { connId, ref } = view
  const t = useT()
  const conn = useConnection(connId)
  const [peeked, setPeeked] = useState<PeekedValue | null>(null)
  const [kv, setKv] = useState<KeyValueResult | null>(null)
  const [loading, setLoading] = useState(false)

  const refKey = JSON.stringify(ref)
  const isKeyValue = ref.kind === 'redisValue'
  // The capability decides, not the ref kind: a driver can address a key and
  // still not implement keyValue, and the button must not promise otherwise.
  const canRead = isKeyValue
    ? bridgeExtras.hasKeyValue() && conn !== null && connHas(conn, 'keyValue')
    : bridgeExtras.hasPeekValue()

  const fetchKeyValue = useCallback(
    (window?: KeyValueWindow) => {
      setLoading(true)
      bridgeExtras
        .getKeyValue(connId, ref, window)
        .then((v) => {
          setKv(v)
        })
        .catch((e: unknown) => {
          // tStatic, not `t`: a toast is worded once, when it is raised (see notifyStore).
          notify('error', tStatic('inspector.fetchFailed'), e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          setLoading(false)
        })
    },
    [connId, refKey],
  )

  useEffect(() => {
    setPeeked(null)
    setKv(null)
    // A key is read as soon as the view opens: one window is small by
    // construction, and a panel that says "(not fetched yet)" about the key the
    // user just double-clicked is a click that did nothing.
    if (isKeyValue && canRead) fetchKeyValue()
  }, [refKey, isKeyValue, canRead, fetchKeyValue])

  // A resultCell hits the local columnar cache directly, no round trip needed
  const local = ref.kind === 'resultCell' ? getCell(ref.resultId, ref.row, ref.col) : undefined
  const hasLocal = local !== undefined && !isPendingCell(local)

  const fetchFull = useCallback(() => {
    if (isKeyValue) {
      fetchKeyValue()
      return
    }
    setLoading(true)
    bridgeExtras
      .peekValue(connId, ref, { offset: 0, length: VALUE_PEEK_MAX_BYTES })
      .then((v) => {
        setPeeked(v)
      })
      .catch((e: unknown) => {
        notify('error', tStatic('inspector.fetchFailed'), e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [connId, refKey, isKeyValue, fetchKeyValue])

  const more = kv ? nextKeyWindow(kv, DEFAULT_KEY_VALUE_ELEMENTS) : null

  return (
    <>
      <div className="toolbar">
        <span>{conn?.label ?? connId}</span>
        <span className="sep" />
        {/* `ref.kind` is the addressing scheme's own name — an identifier. */}
        <span className="mono">{ref.kind}</span>
        <span className="sep" />
        <button className="ghost" disabled={loading || !canRead} onClick={fetchFull}>
          {loading
            ? t('inspector.fetching')
            : isKeyValue
              ? t('inspector.reload')
              : t('inspector.fetchFull')}
        </button>
        {more ? (
          <>
            <span className="sep" />
            <button
              className="ghost"
              disabled={loading}
              onClick={() => {
                fetchKeyValue(more)
              }}
            >
              {t('inspector.nextWindow')} →
            </button>
          </>
        ) : null}
        <span className="grow" />
        {!canRead ? (
          <span style={{ color: 'var(--warn)' }}>
            {isKeyValue ? t('inspector.keyValueUnavailable') : t('inspector.peekUnavailable')}
          </span>
        ) : null}
      </div>

      <ViewError error={view.error} />

      <div className="inspector">
        <div className="kv-grid">
          {refRows(t, ref).map(([k, v]) => (
            <ReadonlyRow key={k} k={k} v={v} />
          ))}
          {/* The driver's own type name, verbatim, next to the shape the UI switched on. */}
          {kv ? <ReadonlyRow k={t('inspector.field.type')} v={kv.type} /> : null}
          {kv ? <ReadonlyRow k={t('inspector.field.shape')} v={kv.value.shape} /> : null}
          {kv?.ttlMs !== undefined ? (
            <ReadonlyRow k={t('inspector.field.ttl')} v={ttlText(t, kv.ttlMs)} />
          ) : null}
          {kv?.size !== undefined ? (
            <ReadonlyRow
              k={t('inspector.field.elements')}
              v={t('inspector.window', { shown: windowSize(kv), total: kv.size })}
            />
          ) : null}
          {kv?.encoding !== undefined ? (
            <ReadonlyRow k={t('inspector.field.encoding')} v={kv.encoding} />
          ) : null}
          {kv?.byteSize !== undefined ? (
            <ReadonlyRow k={t('inspector.field.memory')} v={formatBytes(kv.byteSize)} />
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

        {kv ? (
          <KeyValueBody connId={connId} payload={kv.value} />
        ) : (
          <div className="value-box">
            {peeked
              ? peeked.encoding === 'base64'
                ? `(base64)\n${peeked.data}`
                : peeked.data
              : hasLocal
                ? fullValueText(local)
                : t('inspector.notFetched')}
          </div>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* The typed value                                                     */
/* ------------------------------------------------------------------ */

/**
 * Render one window of a keyValue payload.
 *
 * The switch is exhaustive over `KeyValueShape` deliberately — that is what the
 * union in core buys, and a `default:` here would quietly turn a future shape
 * into a blank panel.
 */
function KeyValueBody({
  connId,
  payload,
}: {
  connId: ConnId
  payload: KeyValuePayload
}): ReactElement {
  const t = useT()
  switch (payload.shape) {
    case 'missing':
      return <div className="value-box">{t('inspector.keyMissing')}</div>
    case 'scalar':
      return (
        <div className="value-box">
          <ElementText connId={connId} element={payload.value} />
        </div>
      )
    case 'map':
      return (
        <ElementTable
          connId={connId}
          head={[t('inspector.col.field'), t('inspector.col.value')]}
          rows={payload.fields.map((f) => [f.field, f.value])}
        />
      )
    case 'list':
      return (
        <ElementTable
          connId={connId}
          // `start` is the absolute index of items[0], so a second window keeps
          // counting rather than restarting at zero.
          head={[t('inspector.col.index'), t('inspector.col.value')]}
          rows={payload.items.map((item, i) => [String(payload.start + i), item])}
        />
      )
    case 'set':
      return (
        <ElementTable
          connId={connId}
          head={['', t('inspector.col.member')]}
          rows={payload.members.map((m) => ['', m])}
        />
      )
    case 'sortedSet':
      return (
        <ElementTable
          connId={connId}
          head={[t('inspector.col.score'), t('inspector.col.member')]}
          rows={payload.entries.map((e) => [String(e.score), e.member])}
        />
      )
    case 'stream':
      return (
        <ElementTable
          connId={connId}
          head={[t('inspector.col.entry'), t('inspector.col.value')]}
          // An entry is itself a list of fields. Flattened to one row per field,
          // labelled `<entry id> · <field>`, so both levels stay readable
          // without nesting a second grid inside this one.
          rows={payload.entries.flatMap((entry) =>
            entry.fields.map(
              (f): [string, KeyValueElement] => [`${entry.id} · ${f.field}`, f.value],
            ),
          )}
        />
      )
  }
}

function ElementTable({
  connId,
  head,
  rows,
}: {
  connId: ConnId
  head: [string, string]
  rows: [string, KeyValueElement][]
}): ReactElement {
  const t = useT()
  if (rows.length === 0) return <div className="value-box">{t('inspector.windowEmpty')}</div>
  return (
    <div className="kv-list">
      <div className="kv-list-row head">
        <div className="k">{head[0]}</div>
        <div className="v">{head[1]}</div>
      </div>
      {rows.map(([label, element], i) => (
        <div className="kv-list-row" key={`${label}:${String(i)}`}>
          <div className="k mono">{label}</div>
          <div className="v mono">
            <ElementText connId={connId} element={element} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * One element of a structure.
 *
 * An element too large for the window travelled as a `TruncatedValue` carrying a
 * `ValueRef` of its own, so the whole thing can be pulled on demand without ever
 * having been materialized into the window — which is the entire reason a
 * 10MB hash field does not break this panel.
 */
function ElementText({
  connId,
  element,
}: {
  connId: ConnId
  element: KeyValueElement
}): ReactElement {
  const t = useT()
  const [full, setFull] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (typeof element === 'string') return <>{element}</>
  if (full !== null) return <>{full}</>

  const ref: ValueRef | undefined = element.ref
  const fetchWhole = (): void => {
    if (!ref) return
    setBusy(true)
    bridgeExtras
      .peekValue(connId, ref, { offset: 0, length: VALUE_PEEK_MAX_BYTES })
      .then((v) => {
        setFull(v.encoding === 'base64' ? `(base64)\n${v.data}` : v.data)
      })
      .catch((e: unknown) => {
        notify('error', tStatic('inspector.fetchFailed'), e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      {element.preview}
      <span className="trunc-mark">
        {' … '}
        {ref && bridgeExtras.hasPeekValue() ? (
          <button className="ghost" disabled={busy} onClick={fetchWhole}>
            {busy ? t('inspector.fetching') : t('inspector.fetchElement')}
          </button>
        ) : (
          t('inspector.elementTruncated', { bytes: formatBytes(element.byteLength ?? 0) })
        )}
      </span>
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

/** -1 is redis's "this key never expires", which is not "-1 ms left". */
function ttlText(t: TFunction, ttlMs: number): string {
  return ttlMs < 0 ? t('inspector.ttlNone') : `${ttlMs} ms`
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
