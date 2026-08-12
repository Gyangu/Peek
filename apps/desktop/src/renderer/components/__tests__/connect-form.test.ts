import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import type { DriverId, SavedConnection } from '@peek/core'
import { connectFormOf, manifestDriverIds, parseConnectionConfig } from '../../../drivers/manifests'
import { CATALOGS } from '../../i18n/catalog'
import { LOCALES } from '../../i18n/locales'
import {
  buildConnectionConfig,
  connectFields,
  connectFormSpec,
  defaultConnectMode,
  initialConnectValues,
  missingRequiredFields,
  seedDriverId,
  validateConnectionConfig,
  type ConnectMode,
} from '../connectForm'

/* ==================================================================
 * The connect dialog's data half.
 *
 * This is the module that decides whether a driver is reachable from the UI at
 * all: a driver with no form is one the user cannot open, however completely its
 * package is implemented. Nothing else in the app checks that — `ConnectDialog`
 * fills its picker from `manifestDriverIds()` and asks this table for the
 * fields, so a missing row shows up as a dialog with no inputs rather than as a
 * build error.
 *
 * The loops below walk that same list rather than core's `DRIVER_IDS`, which is
 * what they used to walk: the registry is what the dialog offers, so it is what
 * has to be covered. Reading the constant would leave a driver that is loaded
 * but not listed there untested — the failure mode a package installed at
 * runtime brings with it.
 *
 * Everything here is pure: no DOM, no driver process, no database.
 * ================================================================== */

/** Every driver this build collected a manifest for; the picker offers exactly these. */
const DRIVER_IDS: readonly DriverId[] = manifestDriverIds()

/** Fill in whatever the form marks required, so the result is submittable. */
function filled(
  driverId: DriverId,
  mode: ConnectMode,
  overrides: Record<string, string | boolean> = {},
): Record<string, string | boolean> {
  const values = initialConnectValues(driverId, mode)
  for (const field of connectFields(driverId, mode)) {
    if (field.required === true && (values[field.name] ?? '') === '') {
      values[field.name] = field.name === 'url' ? sampleUrl(driverId) : `sample-${field.name}`
    }
  }
  return { ...values, ...overrides }
}

function sampleUrl(driverId: DriverId): string {
  switch (driverId) {
    case 'postgres':
      return 'postgresql://user@localhost:5432/db'
    case 'mysql':
      return 'mysql://root:pw@localhost:3306/db'
    case 'redis':
      return 'redis://localhost:6379/0'
    case 'qdrant':
      return 'http://localhost:6333'
    case 'sqlite':
      return '/tmp/whatever.sqlite'
    // `neo4j://`, not `bolt://`: the two are different requests rather than two
    // spellings (routing vs. a pinned server, see the neo4j manifest), and the
    // sample should be the one the form itself defaults to.
    case 'neo4j':
      return 'neo4j://localhost:7687'
    // No longer unreachable: `DriverId` is a string with a shape, so the
    // compiler cannot tell anyone that a seventh driver needs a sample here.
    // Failing loudly is the substitute — a driver with no sample would silently
    // be filled in with `sample-url` and connect nowhere.
    default:
      throw new Error(`connect-form.test.ts has no sample url for ${driverId}`)
  }
}

describe('connect form coverage', () => {
  test('every driver core declares has a form — otherwise the dialog offers an empty one', () => {
    // ConnectDialog renders this same list directly, so this is the invariant
    // that keeps the picker and the form table from drifting apart.
    for (const driverId of DRIVER_IDS) {
      const spec = connectFormSpec(driverId)
      assert.ok(spec, `${driverId} has no form spec`)
      assert.ok(spec.modes.length > 0, `${driverId} declares no input mode`)
      for (const mode of spec.modes) {
        assert.ok(
          connectFields(driverId, mode).length > 0,
          `${driverId} in ${mode} mode would render zero inputs`,
        )
      }
    }
  })

  test('the default mode is one the driver actually offers', () => {
    for (const driverId of DRIVER_IDS) {
      const spec = connectFormSpec(driverId)
      assert.ok(
        spec.modes.includes(defaultConnectMode(driverId)),
        `${driverId} opens in a mode it does not list`,
      )
    }
  })

  test('every field label resolves in every locale', () => {
    // **Changed by decision 3 and by nothing else** (design §2.3c): this used to
    // read `field.labelKey in CATALOGS[locale]`, and the key it looked up no
    // longer exists — a package carries its own text. The question is the same
    // one, asked of the package instead of the window: does every box the dialog
    // draws have a name in the language the dialog is in? A miss still surfaces
    // the same way, as a label nobody chose sitting in the form.
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        for (const field of connectFields(driverId, mode)) {
          for (const { id: locale } of LOCALES) {
            assert.equal(
              typeof field.label[locale],
              'string',
              `${locale} has no label for ${driverId}/${mode}/${field.name}`,
            )
          }
        }
      }
    }
  })

  test('placeholders stay untranslated, and no label is used as one', () => {
    // Placeholders are sample syntax — a URL that reads as prose in one language
    // is harder to copy, not easier — so they are literals by design. This pins
    // that decision so a later "let us translate these too" has to be deliberate.
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        for (const field of connectFields(driverId, mode)) {
          if (field.placeholder === undefined) continue
          assert.ok(
            !(field.placeholder in CATALOGS.en),
            `${driverId}/${field.name} uses a catalog key as its placeholder`,
          )
        }
      }
    }
  })
})

describe('required fields gate the submit button', () => {
  test('a fresh form reports exactly the required fields that have no default', () => {
    // postgres in fields mode pre-fills host and port but cannot guess a database.
    assert.deepEqual(missingRequiredFields('postgres', 'fields', initialConnectValues('postgres', 'fields')), [
      'database',
    ])
    // qdrant's one required field ships with a working default, so the dialog
    // opens ready to submit.
    assert.deepEqual(missingRequiredFields('qdrant', 'fields', initialConnectValues('qdrant', 'fields')), [])
  })

  test('whitespace is not a value', () => {
    const values = { ...initialConnectValues('sqlite', 'fields'), file: '   ' }
    assert.deepEqual(missingRequiredFields('sqlite', 'fields', values), ['file'])
  })

  test('a filled form is submittable for every driver and mode', () => {
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        assert.deepEqual(
          missingRequiredFields(driverId, mode, filled(driverId, mode)),
          [],
          `${driverId}/${mode} still reports missing fields when everything required is filled`,
        )
      }
    }
  })
})

describe('values become a ConnectionConfig core accepts', () => {
  test('every driver and mode assembles a config that passes the contract schema', () => {
    // The same parse main validates `conn.open` against — the registry's, which
    // is the manifest's own field list either side of the process boundary. If
    // this passes here, the dialog cannot produce a config that main rejects
    // with no field to blame.
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        const built = buildConnectionConfig(driverId, mode, filled(driverId, mode), 'label')
        assert.ok(built.ok, `${driverId}/${mode} did not assemble: ${built.ok ? '' : built.issue}`)
        assert.equal(built.config.driverId, driverId)
        assert.notEqual(parseConnectionConfig(built.config, 'keep'), null)
      }
    }
  })

  test('only the visible mode is sent — a stale host cannot redirect a URL connection', () => {
    // The failure this prevents: type a host, switch to URL mode, connect, and
    // land on the host instead of the URL on screen. Both are legal config keys
    // and the driver lets the URL win, so the wrong one arriving is silent.
    const built = buildConnectionConfig(
      'postgres',
      'url',
      { url: 'postgresql://user@example.com:5432/prod', host: 'localhost', port: '5432', database: 'staging' },
      '',
    )
    assert.ok(built.ok)
    const config = built.config as Record<string, unknown>
    assert.equal(config['url'], 'postgresql://user@example.com:5432/prod')
    assert.equal(config['host'], undefined, 'a host from the other mode leaked into a URL connection')
    assert.equal(config['database'], undefined)
  })

  test('blank optional fields are omitted, not sent as empty strings', () => {
    // An empty password is a different claim from no password: one asks the
    // server to authenticate with "", the other lets the driver fall back to its
    // own resolution (.pgpass, a socket peer identity, an env var).
    const built = buildConnectionConfig('postgres', 'fields', filled('postgres', 'fields', { password: '' }), '')
    assert.ok(built.ok)
    assert.equal((built.config as Record<string, unknown>)['password'], undefined)
  })

  test('an empty label is dropped so main can generate one', () => {
    const built = buildConnectionConfig('qdrant', 'fields', filled('qdrant', 'fields'), '   ')
    assert.ok(built.ok)
    assert.equal((built.config as Record<string, unknown>)['label'], undefined)
  })

  test('numeric fields arrive as numbers, not as the strings the inputs hold', () => {
    const built = buildConnectionConfig('redis', 'fields', filled('redis', 'fields', { port: '6380', db: '3' }), '')
    assert.ok(built.ok)
    const config = built.config as Record<string, unknown>
    assert.equal(config['port'], 6380)
    assert.equal(config['db'], 3, 'the redis logical database index must survive as a number')
  })

  test('a non-numeric port is reported against the field instead of being dropped', () => {
    // Number('abc') is NaN and NaN is deliberately allowed to reach the parse:
    // silently omitting the port would connect to 5432 while the box says "abc".
    const built = buildConnectionConfig('postgres', 'fields', filled('postgres', 'fields', { port: 'abc' }), '')
    assert.equal(built.ok, false)
    if (!built.ok) assert.match(built.issue, /port/)
  })

  test('sqlite carries the read-only choice explicitly in both directions', () => {
    // The driver's own default is read-only, so only the unticked case actually
    // needs to travel — but it does need to travel.
    const on = buildConnectionConfig('sqlite', 'fields', filled('sqlite', 'fields', { file: '/tmp/a.db' }), '')
    assert.ok(on.ok)
    assert.equal((on.config as Record<string, unknown>)['readOnly'], true)

    const off = buildConnectionConfig(
      'sqlite',
      'fields',
      filled('sqlite', 'fields', { file: '/tmp/a.db', readOnly: false }),
      '',
    )
    assert.ok(off.ok)
    assert.equal((off.config as Record<string, unknown>)['readOnly'], false)
  })

  test('an unticked checkbox is omitted rather than sent as false', () => {
    // `ssl: false` and "no ssl preference" are the same request today, but the
    // omission is what lets a driver keep its own default. sqlite's readOnly is
    // the deliberate exception above.
    const built = buildConnectionConfig('postgres', 'fields', filled('postgres', 'fields', { ssl: false }), '')
    assert.ok(built.ok)
    assert.equal((built.config as Record<string, unknown>)['ssl'], undefined)
  })

  test('a missing required value fails the parse instead of assembling a half config', () => {
    const built = buildConnectionConfig('sqlite', 'fields', { file: '', readOnly: true }, '')
    assert.equal(built.ok, false)
  })
})

describe('switching driver resets the form', () => {
  test('initial values cover exactly the fields of that driver and mode', () => {
    // ConnectDialog re-seeds from `initialConnectValues` on every driver or mode
    // change; if this returned a partial record, a leftover value from the
    // previous driver would still be in state and could be read by `assemble`.
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        const values = initialConnectValues(driverId, mode)
        assert.deepEqual(
          Object.keys(values).sort(),
          connectFields(driverId, mode)
            .map((f) => f.name)
            .sort(),
          `${driverId}/${mode} seeds a different field set than it renders`,
        )
      }
    }
  })

  test('checkboxes seed as booleans and text fields as strings', () => {
    for (const driverId of DRIVER_IDS) {
      for (const mode of connectFormSpec(driverId).modes) {
        const values = initialConnectValues(driverId, mode)
        for (const field of connectFields(driverId, mode)) {
          const seeded = values[field.name]
          if (field.type === 'checkbox') {
            assert.equal(typeof seeded, 'boolean', `${driverId}/${field.name} should seed as a boolean`)
          } else {
            assert.equal(typeof seeded, 'string', `${driverId}/${field.name} should seed as a string`)
          }
        }
      }
    }
  })
})

describe('what a rejected draft tells the user', () => {
  /*
   * `validateConnectionConfig` is a call to the real parse — core's
   * `parseConnectionConfig`, against the driver's own declared fields — and
   * these tests exist to keep it that way.
   *
   * It was once a hand-written table of per-driver field rules, added to keep
   * zod out of the renderer chunk. Measurement said otherwise on both counts:
   * zod ships regardless (core's `ids.ts` and `errors.ts` are built on it, and
   * the renderer uses both), and the parse is built out of `capability.ts` and
   * `manifest.ts`, which the renderer already pulls in for `ConnectionState`
   * and the connect form itself. The mirror made the built chunk 1,868 B
   * *larger* while being a second copy of a contract main enforces for real.
   *
   * The one property the mirror was genuinely good at is the one asserted here:
   * a rejection names the field, so the dialog can point at a box. Anything that
   * replaces this call has to keep that.
   */

  test('the issue names the offending field, not just that something is wrong', () => {
    const outcome = validateConnectionConfig({ driverId: 'postgres', port: 'not-a-number' }, connectFormOf)
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.issue, /^port: /)
  })

  test('a required field left out is reported against that field', () => {
    const outcome = validateConnectionConfig({ driverId: 'sqlite' }, connectFormOf)
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.match(outcome.issue, /^file: /)
  })

  test('a driver outside the union is refused rather than passed to main', () => {
    const outcome = validateConnectionConfig({ driverId: 'oracle', url: 'x' }, connectFormOf)
    assert.equal(outcome.ok, false)
  })

  test('an accepted draft comes back as the schema parsed it, unknown keys dropped', () => {
    // `z.object` strips what it does not declare. The dialog relies on that: a
    // stale value from the other mode must not survive into the config, and the
    // check here is the last place it could be removed.
    const outcome = validateConnectionConfig(
      {
        driverId: 'sqlite',
        file: '/tmp/a.db',
        readOnly: true,
        somethingElse: 'should not travel',
      },
      connectFormOf,
    )
    assert.ok(outcome.ok)
    assert.deepEqual(outcome.config, { driverId: 'sqlite', file: '/tmp/a.db', readOnly: true })
  })

  test('the accepted config is exactly what main will accept', () => {
    // Same parse, same answer — which is the entire reason to call it here
    // rather than to describe it a second time.
    const outcome = validateConnectionConfig({ driverId: 'redis', host: 'localhost', port: 6379, db: 0 }, connectFormOf)
    assert.ok(outcome.ok)
    assert.notEqual(parseConnectionConfig(outcome.config, 'keep'), null)
  })
})

/* ------------------------------------------------------------------ */
/* What a blank form opens on                                          */
/* ------------------------------------------------------------------ */

/**
 * One book entry. Only two of its fields decide anything here, and the rest are
 * filled because `SavedConnection` is a shape main promises rather than a bag —
 * a partial cast would let this suite keep passing if the two that matter were
 * renamed.
 */
function entry(driverId: DriverId, lastUsedAt: string): SavedConnection {
  return {
    id: `${driverId}:${lastUsedAt}`,
    driverId,
    identity: `${driverId}://sample`,
    label: driverId,
    detail: '',
    config: { driverId } as SavedConnection['config'],
    hasSecret: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt,
  }
}

const INSTALLED: readonly DriverId[] = ['neo4j', 'postgres', 'redis']

describe('seedDriverId — the driver a blank connect form opens on', () => {
  /*
   * The literal `'postgres'` this replaces was not merely a wrong default: it
   * was a lookup for a manifest that a user can uninstall, and the throw landed
   * in a render, which unmounts the window. So the cases below are all one
   * question — can this function name a driver that is not installed — asked
   * from each direction a driver id can arrive from.
   */
  test('the most recently used driver in the book wins', () => {
    const book = [
      entry('postgres', '2026-08-01T00:00:00.000Z'),
      entry('redis', '2026-08-09T00:00:00.000Z'),
      entry('neo4j', '2026-08-05T00:00:00.000Z'),
    ]
    assert.equal(seedDriverId(book, INSTALLED), 'redis')
  })

  test('an uninstalled driver is skipped, however recently it was used', () => {
    // The regression that matters: uninstall the database you use most, and the
    // book still names it. Seeding from it is the same crash through a door the
    // picker does not have.
    const book = [
      entry('postgres', '2026-08-09T00:00:00.000Z'),
      entry('redis', '2026-08-02T00:00:00.000Z'),
    ]
    assert.equal(seedDriverId(book, ['neo4j', 'redis']), 'redis')
  })

  test('a book with nothing installed left in it falls back to the first installed driver', () => {
    const book = [entry('postgres', '2026-08-09T00:00:00.000Z')]
    assert.equal(seedDriverId(book, ['neo4j', 'redis']), 'neo4j')
  })

  test('an empty book falls back to the first installed driver', () => {
    assert.equal(seedDriverId([], INSTALLED), 'neo4j')
  })

  test('nothing installed answers null rather than throwing or inventing one', () => {
    // A legal state since Phase C (design 2026-08-07 decision 1), and the reason
    // this function takes its list as an argument: proving it needs an empty
    // registry, which the process running this suite does not have.
    assert.equal(seedDriverId([], []), null)
    assert.equal(seedDriverId([entry('postgres', '2026-08-09T00:00:00.000Z')], []), null)
  })

  test('the same timestamp twice keeps the earlier entry, so the answer is not the book order', () => {
    const stamp = '2026-08-09T00:00:00.000Z'
    assert.equal(seedDriverId([entry('redis', stamp), entry('neo4j', stamp)], INSTALLED), 'redis')
  })

  test('every driver it can answer with is one the form can actually be drawn for', () => {
    // The property behind all of the above: whatever comes back is a driver
    // `connectFormSpec` will not throw on.
    const installed = manifestDriverIds()
    const seeded = seedDriverId([], installed)
    assert.notEqual(seeded, null)
    if (seeded !== null) assert.ok(connectFormSpec(seeded).modes.length > 0)
  })
})
