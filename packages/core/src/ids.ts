import { z } from 'zod'

/**
 * Branded types.
 *
 * All of them come from zod's `.brand()`, which keeps the schema and the TS type
 * from a single source — the validator *is* the type, so there is no second
 * declaration to drift out of sync.
 *
 * Two ways to turn a bare string into a branded one:
 *   1. Through the schema: `ConnIdSchema.parse(raw)` — mandatory for external input.
 *   2. Through a constructor: `asConnId(raw)` / `newConnId()` — for values already
 *      known to be safe internally.
 */

export const ConnIdSchema = z.string().min(1).brand<'ConnId'>()
export type ConnId = z.infer<typeof ConnIdSchema>

export const ViewIdSchema = z.string().min(1).brand<'ViewId'>()
export type ViewId = z.infer<typeof ViewIdSchema>

export const PanelIdSchema = z.string().min(1).brand<'PanelId'>()
export type PanelId = z.infer<typeof PanelIdSchema>

/** Id of a split node in the tiled layout tree; layout.setRatio addresses splits by it */
export const SplitIdSchema = z.string().min(1).brand<'SplitId'>()
export type SplitId = z.infer<typeof SplitIdSchema>

/** Id of one query's or scan's result set; every chunk in the stream is attributed by it */
export const ResultIdSchema = z.string().min(1).brand<'ResultId'>()
export type ResultId = z.infer<typeof ResultIdSchema>

/* ------------------------------------------------------------------ */
/* Assertion constructors: only for strings already known to be safe    */
/* ------------------------------------------------------------------ */

export const asConnId = (raw: string): ConnId => raw as ConnId
export const asViewId = (raw: string): ViewId => raw as ViewId
export const asPanelId = (raw: string): PanelId => raw as PanelId
export const asSplitId = (raw: string): SplitId => raw as SplitId
export const asResultId = (raw: string): ResultId => raw as ResultId

/* ------------------------------------------------------------------ */
/* Id generation                                                       */
/* ------------------------------------------------------------------ */

let seq = 0

/**
 * Generate a short, prefixed id. A per-process monotonic counter plus a timestamp
 * plus a random tail, which keeps ids from colliding across processes (main and
 * the driver hosts) too.
 *
 * `crypto.randomUUID` is deliberately avoided: the renderer is not guaranteed to
 * be a secure context under `file://`.
 */
export function makeId(prefix: string): string {
  seq += 1
  const t = Date.now().toString(36)
  const n = seq.toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${t}${n}${r}`
}

export const newConnId = (): ConnId => asConnId(makeId('conn'))
export const newViewId = (): ViewId => asViewId(makeId('view'))
export const newPanelId = (): PanelId => asPanelId(makeId('panel'))
export const newSplitId = (): SplitId => asSplitId(makeId('split'))
export const newResultId = (): ResultId => asResultId(makeId('res'))
/** Command envelope id — a plain string, deliberately not branded */
export const newCommandId = (): string => makeId('cmd')
