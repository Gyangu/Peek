import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ConnectField, ConnectMode, DriverManifest } from '@peek/core'
import '../../../drivers/__tests__/in-repo-registry'
import { driverManifests, manifestDriverIds } from '../../../drivers/manifests'
import { LOCALES, type Locale } from '../locales'

/* ==================================================================
 * The connect forms, measured against the locales peek ships.
 *
 * **This file used to measure them against peek's own catalogs**, because a
 * `ConnectField` carried a `labelKey` and the text lived in `messages/`. Under
 * decision 3 (design 2026-08-07 §2.3c) a package carries its own text, so there
 * is no key to look up and no catalog to look it up in — the join this file
 * existed to check does not exist.
 *
 * What remains is a real question and a narrower one: **do the packages peek
 * ships speak every language peek ships?** The schema
 * (`PackageConnectFieldSchema`) only demands `en`, and it is right to — a
 * package translated into nothing must still install. That floor is exactly
 * what an in-repo package must not sit on, and nothing else would notice: a
 * missing translation falls back to English, so a Chinese user gets an English
 * label inside an otherwise Chinese dialog and no process raises anything.
 *
 * The compile-time half is gone with the keys. `connectForm.ts` records what
 * that cost; the replacement for a third-party package is the loader refusing a
 * field with no `en`, and the replacement for an in-repo one is this file.
 *
 * Nothing here connects to anything: manifests are static data, described
 * before a connection exists.
 * ================================================================== */

const MANIFESTS: readonly DriverManifest[] = driverManifests()

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
    assert.ok(ids.length > 0, 'the installed registry is empty, so none of the checks below prove anything')
    // Two manifests under one id means `lookupManifest` answers with whichever
    // was declared last, and one driver draws another driver's connect form.
    assert.deepEqual([...new Set(ids)], ids, `two manifests share a driverId: ${ids.join(', ')}`)
  })

  test('every field label is written in every locale peek ships, not only in English', () => {
    for (const manifest of MANIFESTS) {
      for (const mode of MODES) {
        for (const field of manifest.connectForm.fields[mode]) {
          for (const locale of ALL_LOCALES) {
            // `localizedText` would answer the English here and the dialog would
            // look fine to anyone reading English, which is why the raw record
            // is what is asserted on.
            const written: unknown = field.label[locale]
            assert.ok(
              typeof written === 'string' && written !== '',
              `${where(manifest, mode, field)}: label has no ${locale} text — it falls back to ` +
                `'${field.label.en}' in an otherwise ${locale} dialog, with nothing to warn anyone`,
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
        // `assembleFromForm` sends a value the user believes belongs to the
        // other field.
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
        // has no box to type into and `assembleFromForm` reads nothing.
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
