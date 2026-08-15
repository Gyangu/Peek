import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import './in-repo-registry'
import type { ConnectionConfig, DriverDisplay, DriverId } from '@peek/core'
import { manifestDriverIds } from '../manifests'
import { DRIVER_DISPLAYS } from './in-repo-displays'

/* ==================================================================
 * What a display does with a config that never met its schema.
 *
 * `connection-label.test.ts` next door checks the answers; this file checks
 * that there *is* one. The three strings are the first thing peek does with a
 * connection it has just restored, and they run over six independent
 * implementations that core cannot see inside — so "does every one of them
 * survive a config with a field missing" is a property of the set, not of any
 * package, and it belongs in one place rather than six.
 *
 * The state under test is one the union has ruled out: `sqlite.file` and
 * `qdrant.url` are required, so a config without them cannot be written down.
 * It still arrives: `connections.json` is a file the user can edit and an older
 * peek can have written differently, and every row of it is a config that can be
 * re-opened. A `conn.open` hands it straight to the owning package's host to be
 * named.
 *
 * It used to arrive at a worse moment than that — the book derived a label for
 * *every* archived entry, so one throw emptied the sidebar rather than leaving a
 * row unnamed (§2.3(b-2) ended that). The asymmetry is still worth keeping out,
 * and for the reason it was worth catching in the first place: five packages
 * naming a bad config after its driver while the sixth raised `TypeError: Cannot
 * read properties of undefined` was nobody's decision, it was a `.replace` left
 * at the end of a fallback chain someone shortened.
 * ================================================================== */

/**
 * Every driver this build collected a manifest for.
 *
 * The registry rather than core's `DRIVER_IDS`, which is what this walked
 * before. The property under test is about the *displays that exist*, and what
 * decides that is which packages were collected — a list in core naming six ids
 * cannot answer it once a package can arrive from disk.
 */
const DRIVER_IDS: readonly DriverId[] = manifestDriverIds()

/**
 * A config built the way an unvalidated one really arrives: parsed, not written.
 *
 * `JSON.parse` answers `any`, and leaning on that is the honest spelling rather
 * than a way past the compiler — the whole subject here is a value that reached
 * the app without the schema's guarantees, and a hand-written literal is exactly
 * what the type system will not let anyone produce.
 */
function unvalidated(driverId: DriverId): ConnectionConfig {
  return JSON.parse(`{"driverId":${JSON.stringify(driverId)}}`)
}

describe('a display handed a config that skipped its schema', () => {
  test('there is something to check — an empty id list would make every case below vacuous', () => {
    assert.ok(DRIVER_IDS.length > 0, 'no driver has a manifest, so none of the cases below prove anything')
  })

  for (const driverId of DRIVER_IDS) {
    test(`${driverId} names it instead of throwing`, () => {
      const config = unvalidated(driverId)
      const display: DriverDisplay | undefined = DRIVER_DISPLAYS[driverId]
      assert.ok(display, `${driverId} has a manifest but no display`)
      // The three called the way the package host calls them: straight off the
      // object its `contrib.mjs` exports, one call each, no dispatcher in
      // between. Anything that stood between would be app code no process runs.
      const answers = {
        label: display.label(config),
        detail: display.detail(config),
        endpoint: display.endpoint(config),
      }
      for (const [which, answer] of Object.entries(answers)) {
        // `typeof`, on a value the signature already types as `string`: an
        // implementation that returns a missing field returns `undefined` here,
        // which type-checks at the call site and then reaches an MCP receipt as
        // the word "undefined".
        assert.equal(
          typeof answer,
          'string',
          `${driverId}: ${which} answered a ${typeof answer}, not a string`,
        )
        assert.notEqual(answer, '', `${driverId}: ${which} answered an empty string, which names nothing`)
      }
    })
  }
})
