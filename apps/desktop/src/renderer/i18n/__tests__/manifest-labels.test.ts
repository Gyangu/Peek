import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ConnectField, ConnectMode, DriverManifest } from '@peek/core'
import { DRIVER_MANIFESTS, manifestDriverIds } from '../../../drivers/manifests'
import { CATALOGS } from '../catalog'
import { LOCALES, type Locale } from '../locales'

/* ==================================================================
 * The connect forms, measured against the catalogs they are rendered with.
 *
 * A `ConnectField` carries a `labelKey`, not a label: the field lists live in
 * the driver packages, which have no i18n runtime, and the text lives here.
 * That key is the only thing joining the two halves, and nothing inside a
 * driver package can tell whether it names a real message.
 *
 * The compile-time half of the join is a single annotation in
 * `renderer/components/connectForm.ts`, and it is fragile by construction. It
 * measures every `labelKey` against `PlainMessageKey`, which is derived from
 * the **English** catalog alone — so a key that exists in `en` and nowhere else
 * compiles, which is the failure this file exists for. At runtime
 * `translateDynamic` falls back to the English catalog, so a Chinese user is
 * shown an English label inside an otherwise Chinese dialog; a key missing from
 * every catalog renders as the raw key itself (see `translate`). Neither raises
 * anything, in any process.
 *
 * That annotation also has literal types to measure only because
 * `defineManifest`'s `const` type parameter preserved them: both spellings that
 * widen them (`: DriverManifest` on a manifest, a type annotation on
 * `DRIVER_MANIFESTS`) still compile, and the check then passes on `string`.
 * These assertions do not care how the keys were typed — they read the shipped
 * `CATALOGS`, once per locale.
 *
 * Nothing here connects to anything: manifests are static data, described
 * before a connection exists.
 * ================================================================== */

/**
 * The manifests, widened on purpose.
 *
 * The literal `labelKey` types are what `connectForm.ts` is for; here they are
 * only ever read as strings, and the widened element type is also what lets
 * `connectForm.fields` be indexed by a `ConnectMode` variable.
 */
const MANIFESTS: readonly DriverManifest[] = DRIVER_MANIFESTS

/**
 * Both modes, whether or not a manifest lists them.
 *
 * `fields` is total over `ConnectMode`, so a driver with one mode still parks an
 * array under the other (sqlite and qdrant leave `url` empty). Walking both is
 * what catches a stale field sitting in a mode nobody draws today — it becomes
 * user-visible the moment that mode is offered.
 */
const MODES: readonly ConnectMode[] = ['url', 'fields']

const ALL_LOCALES: readonly Locale[] = LOCALES.map((l) => l.id)

function where(manifest: DriverManifest, mode: ConnectMode, field: ConnectField): string {
  return `${manifest.driverId} / ${mode} / ${field.name}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('driver manifest labels', () => {
  test('there is something to check — an empty manifest list would make every assertion here vacuous', () => {
    const ids = manifestDriverIds()
    assert.ok(ids.length > 0, 'DRIVER_MANIFESTS is empty, so none of the checks below prove anything')
    // Two manifests under one id means `lookupManifest` answers with whichever
    // was declared last, and one driver draws another driver's connect form.
    assert.deepEqual([...new Set(ids)], ids, `two manifests share a driverId: ${ids.join(', ')}`)
  })

  test('every field label exists in every locale, not only in English', () => {
    for (const manifest of MANIFESTS) {
      for (const mode of MODES) {
        for (const field of manifest.connectForm.fields[mode]) {
          for (const locale of ALL_LOCALES) {
            assert.ok(
              CATALOGS[locale][field.labelKey] !== undefined,
              `${where(manifest, mode, field)}: catalog ${locale} has no ${field.labelKey} — ` +
                'the label falls back to English, or renders as the key, with nothing to warn anyone',
            )
          }
        }
      }
    }
  })

  test('no two fields of one mode write the same value key', () => {
    for (const manifest of MANIFESTS) {
      for (const mode of MODES) {
        // `name` is the key into the form's value record *and* the config
        // property it fills, so a duplicate is not a cosmetic clash: both boxes
        // read and write one slot, the second one typed into wins, and
        // `assembleConfig` sends a value the user believes belongs to the other
        // field.
        const names = manifest.connectForm.fields[mode].map((f) => f.name)
        assert.deepEqual(
          [...new Set(names)],
          names,
          `${manifest.driverId} / ${mode}: duplicate field name in ${names.join(', ')}`,
        )
      }
    }
  })

  test('every driver offers a mode, and every offered mode draws at least one field', () => {
    for (const manifest of MANIFESTS) {
      const { modes, fields } = manifest.connectForm
      // `defaultConnectMode` falls back to 'fields' for an empty list, so an
      // empty `modes` does not throw — it opens a dialog with nothing in it.
      assert.ok(modes.length > 0, `${manifest.driverId}: connectForm.modes is empty, so no mode can be offered`)
      for (const mode of modes) {
        // A driver whose offered mode draws no field is one the user cannot
        // connect with, however complete the rest of its package is: the form
        // has no box to type into and `assembleConfig` reads nothing.
        assert.ok(
          fields[mode].length > 0,
          `${manifest.driverId}: mode '${mode}' is offered but draws no field`,
        )
      }
    }
  })

  test('the MCP connect example is JSON for its own driver and carries no credential', () => {
    for (const manifest of MANIFESTS) {
      const example = manifest.mcpConnectExample
      let parsed: unknown
      try {
        parsed = JSON.parse(example)
      } catch {
        // The example is pasted into a real `connect` call by whoever reads the
        // instructions, so "nearly JSON" is a broken example, not a typo.
        assert.fail(`${manifest.driverId}: mcpConnectExample is not JSON: ${example}`)
      }
      assert.ok(isRecord(parsed), `${manifest.driverId}: mcpConnectExample must be a JSON object: ${example}`)
      // Filed under another driver's id, the example connects somewhere the
      // reader did not ask for — or nowhere, which reads as peek being broken.
      assert.equal(
        parsed['driverId'],
        manifest.driverId,
        `${manifest.driverId}: mcpConnectExample claims driverId ${String(parsed['driverId'])}`,
      )

      // The string is shown verbatim to every connected MCP client, so a
      // credential in it is a credential published to all of them. The secret
      // names come from the form itself — a driver that adds a password-typed
      // field is covered here without editing this test.
      const secrets = new Set<string>(['password', 'apiKey'])
      for (const mode of MODES) {
        for (const field of manifest.connectForm.fields[mode]) {
          if (field.type === 'password') secrets.add(field.name)
        }
      }
      for (const name of secrets) {
        assert.equal(
          parsed[name],
          undefined,
          `${manifest.driverId}: mcpConnectExample must not carry '${name}'`,
        )
      }

      // Including one hidden in a connection string's userinfo, which no field
      // name would catch: `postgresql://user:secret@host/db`.
      const url = parsed['url']
      if (typeof url === 'string') {
        assert.ok(
          !/:\/\/[^/@]*:[^/@]*@/.test(url),
          `${manifest.driverId}: mcpConnectExample embeds a password in its url: ${url}`,
        )
      }
    }
  })
})
