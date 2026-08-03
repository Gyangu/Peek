import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type {
  Capability,
  ConnId,
  ConnStatus,
  ConnectionState,
  DriverId,
} from '@peek/core'
import { driverCapabilities, manifestDriverIds } from '../../../drivers/manifests'
import { connCanUse, connCapabilities, connHas } from '../capabilities'

/* ==================================================================
 * Which controls a connection gets to show.
 *
 * The whole point of the capability model is that the UI adapts instead of
 * offering a SQL editor on redis, and this module is the single place that
 * decides. It exists to paper over a race: `ConnectionState.capabilities` starts
 * empty and is filled in only when the driver host reports, so a button keyed on
 * that array directly appears, disappears, and reappears while connections come
 * up. Every test below is about that seam.
 * ================================================================== */

function conn(overrides: Partial<ConnectionState> & { driverId: DriverId }): ConnectionState {
  return {
    id: 'conn_test' as ConnId,
    label: 'test',
    config: { driverId: overrides.driverId } as ConnectionState['config'],
    status: 'ready' as ConnStatus,
    capabilities: [],
    ...overrides,
  }
}

describe('the two-phase capability answer', () => {
  test('falls back to the static prediction while the session has not reported', () => {
    // A connection that is still handshaking has an empty array. Reading that as
    // "this driver can do nothing" is what makes the toolbar flicker.
    const connecting = conn({ driverId: 'postgres', status: 'connecting', capabilities: [] })
    assert.deepEqual(connCapabilities(connecting), driverCapabilities().postgres)
    assert.equal(connHas(connecting, 'tabularQuery'), true)
  })

  test('the live session wins once it reports, even when it reports less', () => {
    // An older server or a degraded driver is allowed to come back narrower than
    // the static table promised, and the UI must believe it rather than the table.
    const degraded = conn({ driverId: 'postgres', capabilities: ['introspect'] })
    assert.deepEqual(connCapabilities(degraded), ['introspect'])
    assert.equal(connHas(degraded, 'tabularQuery'), false, 'the static prediction must not override the session')
  })

  test('an empty report from a ready connection still reads as the prediction', () => {
    // Deliberate: emptiness is treated as "has not answered yet", not as an
    // answer. A driver that genuinely supports nothing could not be connected to
    // in the first place, since core asserts capabilities at connect time.
    const ready = conn({ driverId: 'redis', status: 'ready', capabilities: [] })
    assert.deepEqual(connCapabilities(ready), driverCapabilities().redis)
  })
})

describe('connCanUse also requires the connection to be up', () => {
  test('a capability the driver has is still unusable until the connection is ready', () => {
    for (const status of ['connecting', 'error', 'closed'] as ConnStatus[]) {
      const c = conn({ driverId: 'postgres', status, capabilities: [...driverCapabilities().postgres] })
      assert.equal(connHas(c, 'tabularQuery'), true, `${status}: the driver still has the capability`)
      assert.equal(connCanUse(c, 'tabularQuery'), false, `${status}: but it must not be clickable`)
    }
  })

  test('ready plus present is the only combination that enables a control', () => {
    const c = conn({ driverId: 'postgres', status: 'ready', capabilities: [...driverCapabilities().postgres] })
    assert.equal(connCanUse(c, 'tabularQuery'), true)
    assert.equal(connCanUse(c, 'vectorSearch'), false)
  })
})

describe('the per-driver UI shape this produces', () => {
  /**
   * The table from PLAN §4, restated as what the user sees. These assertions are
   * the reason the module exists, so they name the control rather than the
   * capability wherever the two differ.
   */
  test('redis never offers a SQL editor, and qdrant never offers one either', () => {
    // Sidebar draws no query button at all when `connHas` is false, rather than a
    // disabled one: "not yet" and "not ever" should not look the same.
    assert.equal(connHas(conn({ driverId: 'redis' }), 'tabularQuery'), false)
    assert.equal(connHas(conn({ driverId: 'qdrant' }), 'tabularQuery'), false)
  })

  test('the keyValue inspector is redis-only among the five', () => {
    const withKeyValue = (['postgres', 'mysql', 'sqlite', 'redis', 'qdrant'] as DriverId[]).filter((d) =>
      connHas(conn({ driverId: d }), 'keyValue'),
    )
    assert.deepEqual(withKeyValue, ['redis'])
  })

  test('the vector search view is qdrant-only among the five', () => {
    const withVector = (['postgres', 'mysql', 'sqlite', 'redis', 'qdrant'] as DriverId[]).filter((d) =>
      connHas(conn({ driverId: d }), 'vectorSearch'),
    )
    assert.deepEqual(withVector, ['qdrant'])
  })

  test('qdrant alone cannot cancel, so its views must not draw a cancel button', () => {
    // An HTTP driver with no server-side statement cancellation declines the
    // capability rather than pretending; VectorView keys its cancel button on it.
    assert.equal(connHas(conn({ driverId: 'qdrant' }), 'cancel'), false)
    for (const driverId of ['postgres', 'mysql', 'sqlite', 'redis'] as DriverId[]) {
      assert.equal(connHas(conn({ driverId }), 'cancel'), true, `${driverId} should support cancel`)
    }
  })

  test('every driver can be browsed and scanned — the two the shell always assumes', () => {
    // Sidebar's tree button and the table view are drawn unconditionally, so a
    // driver lacking either would leave a control that can never work.
    for (const driverId of manifestDriverIds()) {
      const c = conn({ driverId })
      assert.equal(connHas(c, 'introspect'), true, `${driverId} must support introspect`)
      assert.equal(connHas(c, 'collectionScan'), true, `${driverId} must support collectionScan`)
    }
  })

  test('no driver claims a capability outside the declared union', () => {
    const known: readonly Capability[] = [
      'introspect',
      'tabularQuery',
      'collectionScan',
      'keyValue',
      'vectorSearch',
      'valuePeek',
      'cancel',
    ]
    for (const [driverId, caps] of Object.entries(driverCapabilities())) {
      for (const cap of caps) {
        assert.ok(known.includes(cap), `${driverId} declares an unknown capability ${cap}`)
      }
    }
  })
})
