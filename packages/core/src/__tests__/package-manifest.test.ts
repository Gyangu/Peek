import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { localizedText } from '../index'
import { parsePackageManifest, type PackageManifest } from '../package-manifest'

/* ==================================================================
 * `peek-package.json`, and what it says when it refuses one.
 *
 * The loader shows these strings to someone looking at a directory that did not
 * install, so a refusal that does not name the key is a refusal nobody can act
 * on — which is the failure the design calls out twice (§2.3, §4.2). Every case
 * below therefore asserts **which key** was blamed, not merely that the parse
 * said no.
 *
 * Two of them replaced a compile error rather than covering something that was
 * never checked: `redact` and `identity` naming a field that is not there were
 * an exhaustive `switch` over the config union until the union opened up, and
 * neither mistake fails loudly at runtime — a rule matching nothing scrubs
 * nothing, and an identity field reading as empty collapses two connections onto
 * one keychain entry.
 * ================================================================== */

/**
 * A JSON document, as loosely as the loader holds one.
 *
 * The sample below is built against this and not against `PackageManifest`,
 * which is the point: a literal typed as the manifest would be measured by the
 * compiler first, and the parse would then only ever see values TypeScript had
 * already approved — the opposite of the situation it exists for.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** A manifest with everything right, which every case below breaks one thing in. */
function valid(): { [key: string]: Json } {
  return {
    id: 'postgres',
    version: '0.0.1',
    peek: '^0.1',
    entry: { driver: 'driver.mjs', contrib: 'contrib.mjs', ui: 'ui/' },
    drivers: [
      {
        driverId: 'postgres',
        displayName: 'PostgreSQL',
        capabilities: ['introspect', 'tabularQuery'],
        sqlDialect: 'postgres',
        connectForm: {
          modes: ['url', 'fields'],
          fields: {
            url: [{ name: 'url', type: 'text', label: { en: 'URL' }, required: true }],
            fields: [
              { name: 'host', type: 'text', label: { en: 'Host', 'zh-CN': '主机' } },
              { name: 'port', type: 'number', label: { en: 'Port' }, min: 1, max: 65535 },
              { name: 'password', type: 'password', label: { en: 'Password' } },
            ],
          },
        },
        redact: { password: 'value', url: 'url-password' },
        identity: ['url', 'host', 'port'],
        mcpConnectExample: '{"driverId":"postgres","url":"postgresql://localhost/db"}',
      },
    ],
    viewKinds: [{ kind: 'graph', driverIds: ['postgres'], title: { en: 'Graph', 'zh-CN': '关系图' } }],
    tools: [
      {
        kind: 'command',
        hasRenderer: true,
        name: 'expand_node',
        description: 'Re-centre a graph view on one node.',
        inputSchema: {
          type: 'object',
          properties: { viewId: { type: 'string' }, depth: { type: 'integer' } },
          required: ['viewId'],
        },
        title: 'Expand a graph node',
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ],
  }
}

/** The sample with one thing rewritten, so each case breaks exactly one thing. */
function broken(mutate: (manifest: { [key: string]: Json }) => void): Json {
  const manifest = valid()
  mutate(manifest)
  return manifest
}

/** The first driver entry of a sample under mutation. */
function driverOf(manifest: { [key: string]: Json }): { [key: string]: Json } {
  const drivers = manifest['drivers']
  assert.ok(Array.isArray(drivers), 'the sample has no drivers array')
  const driver = drivers[0]
  assert.ok(typeof driver === 'object' && driver !== null && !Array.isArray(driver))
  return driver
}

/** One mode's field list, live, so a caller can push to it or replace an entry. */
function fieldsOfMode(manifest: { [key: string]: Json }, mode: string): Json[] {
  const form = driverOf(manifest)['connectForm']
  assert.ok(typeof form === 'object' && form !== null && !Array.isArray(form))
  const byMode = form['fields']
  assert.ok(typeof byMode === 'object' && byMode !== null && !Array.isArray(byMode))
  const list = byMode[mode]
  assert.ok(Array.isArray(list), `the sample draws no ${mode} fields`)
  return list
}

/** The first entry of a list the sample carries, live, so a caller can rewrite one key of it. */
function entryOf(manifest: { [key: string]: Json }, key: string): { [key: string]: Json } {
  const list = manifest[key]
  assert.ok(Array.isArray(list), `the sample has no ${key} array`)
  const first = list[0]
  assert.ok(typeof first === 'object' && first !== null && !Array.isArray(first))
  return first
}

function issuesOf(value: Json): readonly string[] {
  const outcome = parsePackageManifest(value)
  assert.equal(outcome.ok, false, 'expected this manifest to be refused')
  return outcome.ok ? [] : outcome.issues
}

/** Refused, and at least one issue names this path. */
function refusedAt(value: Json, path: string): void {
  const issues = issuesOf(value)
  assert.ok(
    issues.some((issue) => issue.startsWith(`${path}:`)),
    `no issue named ${path}; got:\n${issues.join('\n')}`,
  )
}

describe('peek-package.json', () => {
  test('the sample manifest parses, or every case below is testing the wrong failure', () => {
    const outcome = parsePackageManifest(valid())
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
    const manifest: PackageManifest = outcome.manifest
    assert.equal(manifest.id, 'postgres')
    assert.equal(manifest.drivers.length, 1)
    assert.equal(manifest.entry.driver, 'driver.mjs')
    assert.equal(manifest.drivers[0]?.connectForm.fields.fields[1]?.max, 65535)
  })

  test('a package declaring no driver contributes no database', () => {
    refusedAt(broken((m) => { m['drivers'] = [] }), 'drivers')
  })

  test('an id that is not servable is refused, rather than becoming a directory name', () => {
    // The same class `peek-package://` hosts and scan cursors are drawn from. A
    // dot is refused with the separators, so `..` never has to be reasoned about.
    for (const id of ['../etc', 'Postgres', 'com.example.db', '-lead', '']) {
      refusedAt(broken((m) => { m['id'] = id }), 'id')
    }
  })

  test('a version the loader cannot compare is refused', () => {
    // §2.5 orders packages by the first three numbers; 'latest' would compare
    // equal to everything and an upgrade would silently never be offered.
    for (const version of ['1.2', 'latest', 'v1.2.3']) {
      refusedAt(broken((m) => { m['version'] = version }), 'version')
    }
    const ok = parsePackageManifest(broken((m) => { m['version'] = '1.2.3-beta.1' }))
    assert.ok(ok.ok, 'a pre-release tag after three segments is not the schema\'s business')
  })

  test('an entry path that leaves the package directory is refused', () => {
    // A manifest is written by whoever wrote the package, so this string is one
    // peek would otherwise hand to `import()`.
    for (const path of ['../../../.ssh/id_rsa', '/etc/passwd', 'a/../../b', 'C:\\x']) {
      refusedAt(broken((m) => { m['entry'] = { driver: path } }), 'entry.driver')
    }
  })

  test('a field with no label is refused, and the message names where', () => {
    refusedAt(
      broken((m) => {
        fieldsOfMode(m, 'fields')[0] = { name: 'host', type: 'text' }
      }),
      'drivers.0.connectForm.fields.fields.0.label',
    )
  })

  test('a label without English is refused — it is the fallback every other locale rests on', () => {
    refusedAt(
      broken((m) => {
        fieldsOfMode(m, 'fields')[0] = { name: 'host', type: 'text', label: { 'zh-CN': '主机' } }
      }),
      'drivers.0.connectForm.fields.fields.0.label.en',
    )
  })

  test('a labelKey is not a label — the plank came out from under it', () => {
    // It parsed alongside `label` for exactly one step: the in-repo packages
    // spelled their labels as keys into the *renderer's* catalog, which no
    // third-party package can do. They carry their own text now (decision 3),
    // so the key is an unknown field and the label it stood in for is missing.
    refusedAt(
      broken((m) => {
        fieldsOfMode(m, 'fields')[0] = { name: 'host', type: 'text', labelKey: 'connect.field.host' }
      }),
      'drivers.0.connectForm.fields.fields.0.label',
    )
  })

  test('an offered mode that draws no field is refused', () => {
    // A dialog with no boxes: nothing to type into, and `assembleFromForm` reads
    // nothing, so the user is offered a database they cannot connect to.
    refusedAt(
      broken((m) => { fieldsOfMode(m, 'url').length = 0 }),
      'drivers.0.connectForm.fields.url',
    )
  })

  test('two fields of one mode writing the same key are refused', () => {
    // `name` is the key into the form's value record *and* the config property it
    // fills, so the second box typed into wins and the config carries a value the
    // user believes belongs to the other field.
    refusedAt(
      broken((m) => {
        fieldsOfMode(m, 'fields').push({ name: 'host', type: 'text', label: { en: 'Host again' } })
      }),
      'drivers.0.connectForm.fields.fields',
    )
  })

  test('a redact rule for a field that does not exist is refused', () => {
    // It scrubs nothing, and whatever it was meant to scrub goes verbatim into
    // the MCP receipt, the renderer broadcast and the command log.
    refusedAt(
      broken((m) => { driverOf(m)['redact'] = { passwrd: 'value' } }),
      'drivers.0.redact.passwrd',
    )
  })

  test('an identity field that does not exist is refused', () => {
    // It reads as empty on every connection, so two that differ only there share
    // one keychain entry — one account's saved password released to the other.
    refusedAt(broken((m) => { driverOf(m)['identity'] = ['hostname'] }), 'drivers.0.identity')
  })

  test('a driver with no identity fields at all is refused', () => {
    // Every connection of that driver would reduce to the same identity string.
    refusedAt(broken((m) => { driverOf(m)['identity'] = [] }), 'drivers.0.identity')
  })

  test('an omitted redact block parses — the loader warns, it does not refuse', () => {
    // plugin-architecture's decision 5: peek does not validate packages, so a
    // defensive refusal would be theatre over code that can read the config
    // anyway. Absence survives the parse as `undefined` rather than being
    // defaulted to `{}`, which is what leaves the loader something to warn about
    // and still lets sqlite's explicit `{}` mean "I hold no secret".
    const outcome = parsePackageManifest(broken((m) => { delete driverOf(m)['redact'] }))
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
    assert.equal(outcome.manifest.drivers[0]?.redact, undefined)
  })

  test('a driver claiming no capability is refused — no view could ever be opened on it', () => {
    refusedAt(broken((m) => { driverOf(m)['capabilities'] = [] }), 'drivers.0.capabilities')
  })

  test('two drivers of one package under the same id are refused', () => {
    // A lookup answers with whichever was registered last, and one database
    // draws another's connect form.
    refusedAt(
      broken((m) => {
        const drivers = m['drivers']
        assert.ok(Array.isArray(drivers))
        drivers.push(structuredClone(driverOf(m)))
      }),
      'drivers',
    )
  })

  test('every issue is reported at once, so one round of fixing is enough', () => {
    const issues = issuesOf(broken((m) => {
      m['id'] = 'Bad Id'
      m['version'] = 'nope'
    }))
    assert.ok(issues.some((issue) => issue.startsWith('id:')), issues.join('\n'))
    assert.ok(issues.some((issue) => issue.startsWith('version:')), issues.join('\n'))
  })
})

/* ==================================================================
 * The other two things a package contributes.
 *
 * Both are cut in half by §2.4bis(d) and both halves have to be checkable from
 * the half that is data, because the half that is code is in another process
 * that has not been started — that is the whole point of the cut. So every case
 * below is a manifest that would install and then misbehave at a distance: a
 * view kind offered on a database its package cannot read, a tool name a model
 * provider refuses on the way out, a schema that is not the object one a tool
 * call is made of.
 * ================================================================== */
describe('the view kinds a package contributes', () => {
  test('a package that contributes none parses, and reads as none rather than as absent', () => {
    // Unlike `redact`, where absent and empty are two different statements, a
    // package with no view kind and one with an empty list are the same package
    // — so the parse answers with a list every consumer can loop over.
    const outcome = parsePackageManifest(broken((m) => { delete m['viewKinds']; delete m['tools'] }))
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
    assert.deepEqual(outcome.manifest.viewKinds, [])
    assert.deepEqual(outcome.manifest.tools, [])
  })

  test('the sample survives the round trip with its text intact', () => {
    const outcome = parsePackageManifest(valid())
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
    const kind = outcome.manifest.viewKinds[0]
    assert.equal(kind?.kind, 'graph')
    assert.equal(localizedText(kind?.title ?? { en: '' }, 'zh-CN'), '关系图')
  })

  test('a view kind naming a driver the package does not ship is refused', () => {
    // Not a no-op: the kind would be offered on some other package's connection,
    // and opening it forks this package's host to plan a fetch against a
    // database it has never heard of.
    refusedAt(
      broken((m) => { entryOf(m, 'viewKinds')['driverIds'] = ['mysql'] }),
      'viewKinds.0.driverIds',
    )
  })

  test('a view kind offered on no driver at all is refused', () => {
    // Nothing decides where it appears, so it appears nowhere.
    refusedAt(broken((m) => { entryOf(m, 'viewKinds')['driverIds'] = [] }), 'viewKinds.0.driverIds')
  })

  test('a nameless kind is refused — the string is what both registries are keyed by', () => {
    refusedAt(broken((m) => { entryOf(m, 'viewKinds')['kind'] = '' }), 'viewKinds.0.kind')
  })

  test('a title without English is refused, for the reason a label without English is', () => {
    refusedAt(
      broken((m) => { entryOf(m, 'viewKinds')['title'] = { 'zh-CN': '关系图' } }),
      'viewKinds.0.title.en',
    )
  })

  test('a titleKey is not a title — the same plank came out from under it', () => {
    // `view.kind.graph` names an entry in the *renderer's* message catalog,
    // which a package installed from outside this repository cannot add to; it
    // would paint its own key into the tab strip. Decision 3 made this move for
    // `label` and this is the same move for the kind's display name.
    refusedAt(
      broken((m) => {
        m['viewKinds'] = [{ kind: 'graph', driverIds: ['postgres'], titleKey: 'view.kind.graph' }]
      }),
      'viewKinds.0.title',
    )
  })

  test('two view kinds under one name are refused', () => {
    // Both registries are keyed by `kind`, so the second registers over the
    // first and which view opens comes down to load order.
    refusedAt(
      broken((m) => {
        const kinds = m['viewKinds']
        assert.ok(Array.isArray(kinds))
        kinds.push(structuredClone(entryOf(m, 'viewKinds')))
      }),
      'viewKinds',
    )
  })
})

describe('the MCP tools a package contributes', () => {
  test('a name outside the class a model provider carries is refused', () => {
    // The name is published by `tools/list` and travels on to the provider,
    // where the function-name field is letters, digits, `_` and `-`. A refusal
    // there takes the whole tool list with it, one process away from anything
    // that could name the package responsible.
    for (const name of ['expand node', 'expand.node', 'expand/node', '', 'x'.repeat(65)]) {
      refusedAt(broken((m) => { entryOf(m, 'tools')['name'] = name }), 'tools.0.name')
    }
  })

  test('a tool with no description is refused — it is all the model has to choose by', () => {
    refusedAt(broken((m) => { entryOf(m, 'tools')['description'] = '' }), 'tools.0.description')
  })

  test('an input schema that is not an object schema is refused', () => {
    // A tool is called with named arguments. Anything else parses as JSON and
    // then fails at the client, which is one layer past the last place that
    // could say which package it came from.
    const schemas: Json[] = [
      { type: 'array', items: { type: 'string' } },
      { type: 'string' },
      { properties: { viewId: { type: 'string' } } },
      [{ type: 'object' }],
      'object',
      true,
    ]
    for (const schema of schemas) {
      refusedAt(broken((m) => { entryOf(m, 'tools')['inputSchema'] = schema }), 'tools.0.inputSchema')
    }
  })

  test('an object schema whose properties are not schemas is refused', () => {
    const badProperties: Json[] = [{ viewId: 'string' }, ['viewId'], { viewId: null }]
    for (const properties of badProperties) {
      refusedAt(
        broken((m) => { entryOf(m, 'tools')['inputSchema'] = { type: 'object', properties } }),
        'tools.0.inputSchema',
      )
    }
  })

  test('a schema peek does not interpret passes through — the dialect is not its business', () => {
    // `$ref`, `allOf`, a boolean subschema: all legal JSON Schema, none of it
    // something peek reads. Refusing it would be a second opinion about a value
    // that is forwarded verbatim.
    const outcome = parsePackageManifest(broken((m) => {
      entryOf(m, 'tools')['inputSchema'] = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { viewId: { $ref: '#/$defs/id' }, anything: true },
        $defs: { id: { type: 'string', minLength: 1 } },
      }
    }))
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
  })

  test('two tools of one package under the same name are refused', () => {
    // A model picks by name and has nothing else to go on, so the second
    // declaration is a coin toss on a call that acts on the user's database.
    // The loader makes the same check across packages, where the namespace is
    // shared with everyone else's.
    refusedAt(
      broken((m) => {
        const tools = m['tools']
        assert.ok(Array.isArray(tools))
        tools.push(structuredClone(entryOf(m, 'tools')))
      }),
      'tools',
    )
  })

  /* ---------------------------------------------------------------- */
  /* The execution half (§4duodevicies)                                */
  /* ---------------------------------------------------------------- */

  test('a tool that does not say which kind it is cannot be built, so it is refused', () => {
    // `read` and `command` are two constructors in the executor. Defaulting to
    // either would wire half of every package's tools to the wrong one, and
    // silently: a read tool built as a command tool answers by dispatching.
    refusedAt(broken((m) => { delete entryOf(m, 'tools')['kind'] }), 'tools.0.kind')
    refusedAt(broken((m) => { entryOf(m, 'tools')['kind'] = 'query' }), 'tools.0.kind')
  })

  test('a command tool that does not say whether it writes a receipt is refused', () => {
    // `defineCommandTool` reads a missing `render` as "use the default receipt"
    // and there is no third answer, so a stand-in that guessed would either drop
    // a receipt the package wrote or ask for one it does not have.
    refusedAt(broken((m) => { delete entryOf(m, 'tools')['hasRenderer'] }), 'tools.0.hasRenderer')
  })

  test('hasRenderer on a read tool is refused rather than ignored', () => {
    // `z.object` strips what it does not know, so the failure this rules out is
    // the quiet one: the field is accepted, dropped, and believed.
    refusedAt(
      broken((m) => {
        const tool = entryOf(m, 'tools')
        tool['kind'] = 'read'
        tool['hasRenderer'] = false
      }),
      'tools.0.hasRenderer',
    )
  })

  test('a read tool needs nothing beyond the shared fields', () => {
    const outcome = parsePackageManifest(broken((m) => {
      const tool = entryOf(m, 'tools')
      tool['kind'] = 'read'
      delete tool['hasRenderer']
    }))
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
  })

  test('title and annotations are carried, and neither is required', () => {
    const outcome = parsePackageManifest(broken((m) => {
      const tool = entryOf(m, 'tools')
      delete tool['title']
      delete tool['annotations']
    }))
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))

    const kept = parsePackageManifest(valid())
    assert.ok(kept.ok)
    // Carried through unread: peek interprets none of these, and a model
    // provider is the consumer. §4duodevicies(a) is why they are on disk at all
    // — a `destructiveHint` that arrives at first call is not a hint.
    assert.equal(kept.manifest.tools[0]?.title, 'Expand a graph node')
    assert.deepEqual(kept.manifest.tools[0]?.annotations, { readOnlyHint: false, destructiveHint: true })
  })

  test('a schema that cannot become a validator is refused, naming the tool', () => {
    // The one narrowing of "peek holds no opinion about the dialect"
    // (§4duodecies(c) item 1, amended by §4duodevicies(c)): executing a call
    // means validating its arguments, peek validates with zod, so a schema zod
    // cannot represent is a tool with no way to be called. Refusing it here
    // names the package; the alternative surfaces at the model's first attempt.
    refusedAt(
      broken((m) => {
        entryOf(m, 'tools')['inputSchema'] = {
          type: 'object',
          properties: { viewId: { type: 'not-a-json-schema-type' } },
        }
      }),
      'tools.0.inputSchema',
    )
  })

  test('the schemas peek forwards without reading still become validators', () => {
    // The pass-through case above, asked the other way round: `$ref`, `allOf`
    // and a boolean subschema are accepted *and* convertible, so the narrowing
    // did not quietly take the dialect promise back.
    for (const properties of [
      { viewId: { $ref: '#/$defs/id' } },
      { viewId: { allOf: [{ type: 'string' }] } },
      { anything: true },
    ] as Json[]) {
      const outcome = parsePackageManifest(broken((m) => {
        entryOf(m, 'tools')['inputSchema'] = {
          type: 'object',
          properties,
          $defs: { id: { type: 'string', minLength: 1 } },
        }
      }))
      assert.ok(outcome.ok, outcome.ok ? '' : outcome.issues.join('\n'))
    }
  })
})

describe('a package carries its own text', () => {
  test('a locale peek has no translation for falls back to English', () => {
    const label = { en: 'Host', 'zh-CN': '主机' }
    assert.equal(localizedText(label, 'zh-CN'), '主机')
    assert.equal(localizedText(label, 'ja'), 'Host')
  })

  test('a blank translation is absent, not a label', () => {
    // A catalog entry someone left empty names nothing at all; falling back is
    // the only reading that puts a word on screen.
    assert.equal(localizedText({ en: 'Host', 'zh-CN': '' }, 'zh-CN'), 'Host')
  })
})
