import type { DriverId } from './capability'
import { peekErrorMsg } from './errors'

/**
 * `ChunkDone.nextCursor` / `CollectionScanRequest.cursorToken`: what a
 * continuation actually is, decided once instead of three times.
 *
 * ## The three encodings this replaces
 *
 * Every driver invented its own string, and the three had nothing in common but
 * the field they travelled in:
 *
 * | driver          | token             | meaning                              |
 * |-----------------|-------------------|--------------------------------------|
 * | postgres/mysql/sqlite | `'400'`     | absolute row offset                  |
 * | redis           | `'238:17'`        | SCAN boundary, plus rows of that page already sent |
 * | qdrant          | `'"42"'`          | `JSON.stringify` of the next point id |
 *
 * `nextCursor` is documented as opaque to everyone but the driver that minted
 * it, and that was taken to mean nothing needed agreeing. It does, for two
 * reasons.
 *
 * **The shape is not driver-specific — only the boundary is.** Redis needed
 * `<boundary>:<skip>` because a SCAN cursor addresses a *page* while `maxRows`
 * can land anywhere inside one. That is not a redis problem; it is the problem
 * every cursor store has, and qdrant's scroll has it too (it is worked around
 * there by keeping a probe row buffered). Solving it privately in one driver
 * means the next driver solves it again, differently, or does not notice it.
 *
 * **A token from the wrong driver used to be honoured.** Nothing checked who
 * minted one. Hand redis's `'238:17'` to qdrant and `decodeScrollOffset` read it
 * as the string point id `"238:17"`, scrolled from a point that does not exist,
 * and returned an empty page — a wrong answer, silently, from a token the caller
 * had every reason to think was meaningful. Tagging the token with its driver
 * turns that into a BAD_REQUEST.
 *
 * ## The encoding
 *
 *     <driverId>:<skip>:<boundary>
 *
 * `driverId` and `skip` are both drawn from restricted alphabets, so the *first
 * two* colons delimit and everything after them is the boundary, verbatim —
 * which matters, because a boundary is arbitrary driver text (qdrant's is JSON,
 * and a point id may contain anything).
 *
 *     postgres:0:400        row 400 of the result
 *     redis:17:238          SCAN boundary 238, first 17 matching keys already sent
 *     qdrant:0:"42"         scroll resumes at the string point id "42"
 *
 * It is deliberately readable. A cursor shows up in the command log, in MCP
 * receipts and in bug reports, and `redis:17:238` is something a person can
 * reason about where a base64 blob is not.
 */
export interface ScanCursor {
  /** Which driver minted it; a token handed to any other driver is refused */
  driverId: DriverId
  /**
   * The driver's own address of the page the next row lives in.
   *
   * Opaque to core and to every caller: an absolute row offset, a SCAN cursor, a
   * point id — whatever the store can be told to resume from. It may contain
   * anything, including colons.
   */
  boundary: string
  /**
   * How many rows of `boundary`'s page were already delivered.
   *
   * Zero whenever the boundary addresses a row rather than a page, which is the
   * relational case. Non-zero is what makes a cursor store able to stop in the
   * middle of a page: the resume re-reads that page and drops this many rows, so
   * a `limit` that does not divide the page size still produces consecutive,
   * non-overlapping pages.
   */
  skip: number
}

/**
 * `<driverId>:<skip>:<boundary>`. The driver id is lowercase alphanumerics (see
 * `DRIVER_IDS`) and the skip is digits, so neither can swallow a colon that
 * belongs to the boundary.
 *
 * **The id class must stay in step with `DRIVER_IDS`.** It was `[a-z]+` while
 * every id happened to be pure letters, and `neo4j` — the first one with a digit
 * in it — did not match: `encodeScanCursor` minted `neo4j:0:7` and
 * `decodeScanCursor` refused its own output as malformed. The visible failure is
 * a scan that silently cannot continue past its first page, on that driver only.
 * `scan-cursor.test.ts` catches it because it loops over `DRIVER_IDS` rather than
 * over a hand-written list.
 *
 * Digits are safe to admit here: the skip group is anchored between two colons
 * and is matched greedily after the id, so a numeric id cannot swallow it.
 */
const CURSOR_TOKEN_RE = /^([a-z][a-z0-9]*):(\d+):([\s\S]*)$/

export function encodeScanCursor(cursor: ScanCursor): string {
  const skip = Number.isFinite(cursor.skip) ? Math.max(0, Math.trunc(cursor.skip)) : 0
  return `${cursor.driverId}:${String(skip)}:${cursor.boundary}`
}

/** Parse a token, or null when it is not one. Never throws. */
export function tryDecodeScanCursor(token: string): ScanCursor | null {
  const m = CURSOR_TOKEN_RE.exec(token)
  if (m === null) return null
  const [, driverId, skip, boundary] = m
  if (driverId === undefined || skip === undefined || boundary === undefined) return null
  const n = Number(skip)
  if (!Number.isSafeInteger(n)) return null
  return { driverId: driverId as DriverId, boundary, skip: n }
}

/**
 * Parse a token that must have been minted by `driverId`, or refuse it.
 *
 * Both failures are BAD_REQUEST and both are the same failure from the caller's
 * point of view — the token does not address this scan — so they share the
 * catalog message. The token itself is in the message because it is the only
 * thing that identifies which stale continuation was replayed.
 */
export function decodeScanCursor(token: string, driverId: DriverId): ScanCursor {
  const parsed = tryDecodeScanCursor(token)
  if (parsed === null || parsed.driverId !== driverId) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.invalidCursorToken', { token })
  }
  return parsed
}

/**
 * The relational shape: a boundary that is an absolute row offset, with no
 * intra-page remainder because `LIMIT n OFFSET k` addresses rows directly.
 */
export function rowOffsetCursor(driverId: DriverId, offset: number): string {
  return encodeScanCursor({ driverId, boundary: String(Math.max(0, Math.trunc(offset))), skip: 0 })
}

/** Read a `rowOffsetCursor` back, refusing a boundary that is not a row number. */
export function decodeRowOffsetCursor(token: string, driverId: DriverId): number {
  const cursor = decodeScanCursor(token, driverId)
  const offset = Number(cursor.boundary)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw peekErrorMsg('BAD_REQUEST', 'error.sql.invalidCursorToken', { token })
  }
  return offset + cursor.skip
}
