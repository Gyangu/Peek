import { DRIVER_CAPABILITIES, type Capability, type ConnectionState } from '@peek/core'

/* ==================================================================
 * What a connection can do, from the renderer's point of view.
 *
 * There are two answers to that question and they arrive at different times:
 *
 *   before connecting  DRIVER_CAPABILITIES, a static prediction from the driver
 *                      id — enough to draw the dialog and to grey out the query
 *                      button on a redis row that is still handshaking;
 *   once connected     `ConnectionState.capabilities`, reported by the live
 *                      session, which is **authoritative** and may be narrower
 *                      (an older server, a driver that degraded).
 *
 * Every capability check in the UI goes through here so that the switch-over
 * happens in one place. Asking `conn.capabilities.includes(...)` directly is the
 * bug this module exists to prevent: that array is empty until the session
 * reports, so a query button keyed on it flickers off and on as connections come
 * up.
 * ================================================================== */

/**
 * The capability list to render against: the session's own answer once it has
 * one, the static prediction until then.
 *
 * The emptiness test matters more than the status test — a connection can be
 * `ready` for a moment before its capabilities land, and an empty array from a
 * live session is not a claim that the driver can do nothing.
 */
export function connCapabilities(conn: ConnectionState): readonly Capability[] {
  if (conn.capabilities.length > 0) return conn.capabilities
  return DRIVER_CAPABILITIES[conn.driverId]
}

export function connHas(conn: ConnectionState, cap: Capability): boolean {
  return connCapabilities(conn).includes(cap)
}

/**
 * Whether the capability is *usable right now* — the connection is up and the
 * driver has it. This is the one to key a button's `disabled` on; `connHas`
 * alone answers "would this ever work", which is what decides whether the button
 * is drawn at all.
 */
export function connCanUse(conn: ConnectionState, cap: Capability): boolean {
  return conn.status === 'ready' && connHas(conn, cap)
}
