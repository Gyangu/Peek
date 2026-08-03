import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { describe, test } from 'node:test'
import { PLUGIN_CSP, PLUGIN_SCHEME, pluginUiRootFrom, resolvePluginAsset } from '../assets'

/* ==================================================================
 * The containment check on `peek-plugin://`.
 *
 * This is the file that decides whether a URL a *plugin's own frame* composes
 * can reach a file outside that plugin's directory. Everything else about Tier C
 * — the origin, the CSP, the port — assumes it holds, so it is tested by trying
 * to break it rather than by checking that the happy path works.
 *
 * The root is passed in (`pluginUiRootFrom`) precisely so this can run against a
 * fixture path with no filesystem and no Electron. Nothing here reads a file:
 * the question is which path would be opened, not what is in it.
 * ================================================================== */

const ROOT = `${sep}app${sep}out${sep}plugin-ui`
const BASE = `${ROOT}${sep}neo4j`

function ask(url: string): { file: string; mediaType: string } | null {
  return resolvePluginAsset(url, ROOT)
}

describe('resolvePluginAsset serves a plugin its own files', () => {
  test('the document', () => {
    const hit = ask('peek-plugin://neo4j/index.html')
    assert.deepEqual(hit, { file: `${BASE}${sep}index.html`, mediaType: 'text/html; charset=utf-8' })
  })

  test('its bundle and stylesheet, with the media types the CSP needs to be meaningful', () => {
    // `script-src 'self'` only means anything if the script is actually served
    // as a script; a wrong media type here is a blank frame.
    assert.equal(ask('peek-plugin://neo4j/index.js')?.mediaType, 'text/javascript; charset=utf-8')
    assert.equal(ask('peek-plugin://neo4j/index.css')?.mediaType, 'text/css; charset=utf-8')
  })

  test('a nested asset', () => {
    assert.equal(ask('peek-plugin://neo4j/assets/icon.svg')?.file, `${BASE}${sep}assets${sep}icon.svg`)
  })

  test('a query string and a fragment are not part of the path', () => {
    // Vite emits neither, but a frame composing its own URL may; treating `?v=2`
    // as part of the filename would 404 a file that is right there.
    assert.equal(ask('peek-plugin://neo4j/index.js?v=2')?.file, `${BASE}${sep}index.js`)
    assert.equal(ask('peek-plugin://neo4j/index.html#node-1')?.file, `${BASE}${sep}index.html`)
  })
})

describe('resolvePluginAsset refuses everything that leaves the plugin', () => {
  const escapes = [
    ['plain traversal', 'peek-plugin://neo4j/../../main/index.js'],
    ['encoded traversal', 'peek-plugin://neo4j/%2e%2e/%2e%2e/main/index.js'],
    ['double-encoded traversal', 'peek-plugin://neo4j/%252e%252e/main/index.js'],
    ['traversal in the middle of a path', 'peek-plugin://neo4j/assets/../../../renderer/index.html'],
    ['an absolute path', 'peek-plugin://neo4j//etc/passwd'],
    ['a NUL truncation', 'peek-plugin://neo4j/index.html%00.png'],
  ] as const

  for (const [what, url] of escapes) {
    test(what, () => {
      const hit = ask(url)
      // Either refused outright, or resolved to something still inside the
      // plugin — a traversal that `normalize` flattens harmlessly is fine, an
      // escape is not. Asserting containment rather than `null` is what keeps
      // this test honest if the implementation changes how it refuses.
      if (hit !== null) {
        assert.ok(
          hit.file.startsWith(BASE + sep),
          `${url} resolved outside the plugin directory: ${hit.file}`,
        )
      }
    })
  }

  test('a sibling plugin, reached by name rather than by traversal', () => {
    // The one that a prefix test on a *string* rather than on a path boundary
    // would let through: `/app/out/plugin-ui/neo4j-evil` starts with
    // `/app/out/plugin-ui/neo4j`.
    const hit = resolvePluginAsset('peek-plugin://neo4j-evil/index.html', ROOT)
    assert.equal(hit?.file, `${ROOT}${sep}neo4j-evil${sep}index.html`, 'it is its own plugin, not neo4j')
  })
})

describe('resolvePluginAsset refuses ids and types it was not given', () => {
  test('another scheme, even with a valid-looking path', () => {
    // `protocol.handle` only ever calls this for its own scheme, so this is
    // belt-and-braces — but the function is exported and a second caller is
    // exactly how that assumption stops being true.
    assert.equal(ask('file:///app/out/plugin-ui/neo4j/index.html'), null)
    assert.equal(ask('https://neo4j/index.html'), null)
  })

  for (const [what, host] of [
    ['empty', ''],
    ['dotted', 'com.example.thing'],
    ['dot-dot', '..'],
    ['uppercase', 'Neo4J'],
    ['leading dash', '-neo4j'],
    ['with a slash', 'neo4j%2Fevil'],
  ] as const) {
    test(`a ${what} plugin id`, () => {
      assert.equal(ask(`peek-plugin://${host}/index.html`), null)
    })
  }

  test('an extension with no declared media type', () => {
    // Refused rather than served as octet-stream: the alternative leaves the
    // browser to decide what the file is.
    assert.equal(ask('peek-plugin://neo4j/data.wasm'), null)
    assert.equal(ask('peek-plugin://neo4j/LICENSE'), null)
  })
})

describe('the document CSP', () => {
  test('denies the network outright', () => {
    // The single clause the whole Tier C threat model rests on: a plugin's only
    // I/O is the port. If this ever softens to a host list, the design doc's
    // §2.6 claim stops being true.
    assert.match(PLUGIN_CSP, /connect-src 'none'/)
  })

  test('allows the plugin its own scripts and nothing inline', () => {
    assert.match(PLUGIN_CSP, /script-src 'self'/)
    assert.ok(!PLUGIN_CSP.includes("script-src 'self' 'unsafe-inline'"), 'inline script must stay refused')
    assert.ok(!PLUGIN_CSP.includes("'unsafe-eval'"), 'eval must stay refused')
  })

  test('starts from deny-all, so a clause nobody wrote is a denial', () => {
    assert.ok(PLUGIN_CSP.startsWith("default-src 'none'"))
  })

  test('cannot nest a frame or navigate away', () => {
    assert.match(PLUGIN_CSP, /frame-src 'none'/)
    assert.match(PLUGIN_CSP, /form-action 'none'/)
    assert.match(PLUGIN_CSP, /base-uri 'none'/)
  })
})

describe('the scheme and the root', () => {
  test('the scheme is what the renderer builds its iframe URL from', () => {
    // `PluginFrame` writes `peek-plugin://${pluginId}` by hand — it cannot import
    // a main-process module — so this constant and that template are the two
    // copies that must agree.
    assert.equal(PLUGIN_SCHEME, 'peek-plugin')
  })

  test('the root is a sibling of the main bundle, not a child of it', () => {
    assert.equal(pluginUiRootFrom(`${sep}app${sep}out${sep}main`), `${sep}app${sep}out${sep}plugin-ui`)
  })
})
