import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { connectionFieldsOf, type DriverManifest } from '@peek/core'
import './in-repo-registry'
import { driverManifests } from '../manifests'

/* ==================================================================
 * `redact` and `identity` name fields that exist.
 *
 * ## Why this is a test and not a type
 *
 * Both used to be branches of an exhaustive `switch` over `ConnectionConfig`,
 * where `config.passwrd` was a compile error and the question this file asks
 * could not be asked. They are declarations now — `Readonly<Record<string,
 * RedactRule>>` and `readonly string[]` — and an index signature accepts every
 * key, so the checking stopped when the switches went. Narrowing them back to
 * `keyof` the config would only work while the six configs are a union written
 * in core; a package loaded from disk brings its own field list, and that is the
 * direction the design is going
 * (`docs/design/2026-08-07-database-packages-from-disk.md` §2.6). So the check is
 * made against the schema the config is actually parsed by, at the moment the
 * app collects its manifests. The loader makes the same one — it is a
 * `superRefine` on `PackageDriverSchema` in core's `package-manifest.ts` — and
 * the two halves are not redundant: that one covers a package peek did not
 * build, this one covers the six that are compiled in and never go through it.
 * `manifest-versions.test.ts` is the same shape of substitute for the same
 * reason.
 *
 * ## Why a misspelling is worth a test of its own
 *
 * Neither mistake fails loudly. `redactConnectionConfig` walks the rules and
 * skips any field the config does not have, so `{ passwrd: 'value' }` scrubs
 * nothing and the cleartext password goes out along all three paths that carry a
 * config — the MCP receipt, the renderer broadcast, and the command log — none
 * of which has a by-name fallback underneath. `connectionIdentity` reads an
 * absent field as an empty slot, so a misspelt entry discriminates nothing and
 * two connections differing only in that field collapse onto one keychain entry,
 * which releases one account's saved password to the other. Both compile, both
 * pass every other test, and both look right in review.
 * ================================================================== */

/**
 * The field names this driver's config accepts.
 *
 * Read off the manifest's own `connectForm`, which **is** the config schema now
 * — `connectionFieldsOf` is what `parseConnectionConfig` measures a config with,
 * so this asks the same question the parse asks. It used to walk
 * `ConnectionConfigSchema.options` and read the branch whose discriminant
 * matched; there are no branches, because a package loaded from disk brings its
 * own field list and core cannot have written one for it.
 *
 * The set this returns is **narrower** than the old branch's key set: a branch
 * also declared keys no form draws (`connectTimeoutMs`, postgres's `searchPath`),
 * which a config may still carry but which nothing may be identified or redacted
 * by — those have to be fields the user was actually asked for.
 */
function configFields(manifest: DriverManifest): ReadonlySet<string> {
  const names = connectionFieldsOf(manifest.connectForm).map((f) => f.name)
  return new Set(['driverId', 'label', ...names])
}

describe('driver manifest declarations', () => {
  for (const manifest of driverManifests()) {
    test(`${manifest.driverId} redacts fields its config has`, () => {
      const fields = configFields(manifest)
      for (const name of Object.keys(manifest.redact)) {
        assert.ok(
          fields.has(name),
          `${manifest.driverId} declares redact.${name}, which is not a field of its config — the rule matches nothing and whatever it was meant to scrub travels in the clear`,
        )
      }
    })

    test(`${manifest.driverId} is identified by fields its config has`, () => {
      const fields = configFields(manifest)
      for (const name of manifest.identity) {
        assert.ok(
          fields.has(name),
          `${manifest.driverId} identifies connections by ${name}, which is not a field of its config — it reads as empty on every connection, so two that differ only there share one saved credential`,
        )
      }
    })

    // The one field the kernel judges by name rather than by declaration, so the
    // one whose omission it can catch. `connectionIdentity` strips a `url`'s
    // password before hashing it and `config/connection-book.ts` never writes one
    // to disk, both without asking the package — because userinfo in a connection
    // string is a password wherever it appears. A driver that offers the field and
    // declares no rule for it is the case qdrant was: scrubbed on two of the three
    // paths and broadcast whole on the third.
    test(`${manifest.driverId} says how to scrub a url, if it has one`, () => {
      const fields = configFields(manifest)
      if (!fields.has('url')) return
      assert.ok(
        manifest.redact['url'] !== undefined,
        `${manifest.driverId} accepts a url and declares no redact rule for it — a connection string pasted in as scheme://user:secret@host goes verbatim into the MCP receipt, the renderer broadcast and the command log`,
      )
    })
  }
})
