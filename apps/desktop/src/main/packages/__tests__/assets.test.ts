import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { describe, test } from 'node:test'
import { PACKAGE_UI_DIR, PACKAGE_CSP, PACKAGE_SCHEME, resolvePackageAsset } from '../assets'

/* ==================================================================
 * The containment check on `peek-package://`.
 *
 * This is the file that decides whether a URL a *package's own frame* composes
 * can reach a file outside that package's directory. Everything else about Tier C
 * — the origin, the CSP, the port — assumes it holds, so it is tested by trying
 * to break it rather than by checking that the happy path works.
 *
 * The root is passed in precisely so this can run against a fixture path with no
 * filesystem and no Electron. Nothing here reads a file: the question is which
 * path would be opened, not what is in it.
 *
 * That root is now `<configDir>/packages` — a directory the *user* writes to
 * rather than a build output (design 2026-08-07 §2.2), which is what turns every
 * case below from belt-and-braces into the actual boundary.
 * ================================================================== */

const ROOT = `${sep}home${sep}me${sep}.peek${sep}packages`
const BASE = `${ROOT}${sep}neo4j${sep}${PACKAGE_UI_DIR}`

function ask(url: string): { file: string; mediaType: string } | null {
  return resolvePackageAsset(url, ROOT)
}

describe('resolvePackageAsset serves a package its own files', () => {
  test('the document', () => {
    const hit = ask('peek-package://neo4j/index.html')
    assert.deepEqual(hit, { file: `${BASE}${sep}index.html`, mediaType: 'text/html; charset=utf-8' })
  })

  test('its bundle and stylesheet, with the media types the CSP needs to be meaningful', () => {
    // `script-src 'self'` only means anything if the script is actually served
    // as a script; a wrong media type here is a blank frame.
    assert.equal(ask('peek-package://neo4j/index.js')?.mediaType, 'text/javascript; charset=utf-8')
    assert.equal(ask('peek-package://neo4j/index.css')?.mediaType, 'text/css; charset=utf-8')
  })

  test('a nested asset', () => {
    assert.equal(ask('peek-package://neo4j/assets/icon.svg')?.file, `${BASE}${sep}assets${sep}icon.svg`)
  })

  test('a query string and a fragment are not part of the path', () => {
    // Vite emits neither, but a frame composing its own URL may; treating `?v=2`
    // as part of the filename would 404 a file that is right there.
    assert.equal(ask('peek-package://neo4j/index.js?v=2')?.file, `${BASE}${sep}index.js`)
    assert.equal(ask('peek-package://neo4j/index.html#node-1')?.file, `${BASE}${sep}index.html`)
  })
})

describe('resolvePackageAsset refuses everything that leaves the package', () => {
  const escapes = [
    ['plain traversal', 'peek-package://neo4j/../../main/index.js'],
    ['encoded traversal', 'peek-package://neo4j/%2e%2e/%2e%2e/main/index.js'],
    ['double-encoded traversal', 'peek-package://neo4j/%252e%252e/main/index.js'],
    ['traversal in the middle of a path', 'peek-package://neo4j/assets/../../../renderer/index.html'],
    ['an absolute path', 'peek-package://neo4j//etc/passwd'],
    ['a NUL truncation', 'peek-package://neo4j/index.html%00.png'],
  ] as const

  for (const [what, url] of escapes) {
    test(what, () => {
      const hit = ask(url)
      // Either refused outright, or resolved to something still inside the
      // package — a traversal that `normalize` flattens harmlessly is fine, an
      // escape is not. Asserting containment rather than `null` is what keeps
      // this test honest if the implementation changes how it refuses.
      if (hit !== null) {
        assert.ok(
          hit.file.startsWith(BASE + sep),
          `${url} resolved outside the package directory: ${hit.file}`,
        )
      }
    })
  }

  test('a sibling package, reached by name rather than by traversal', () => {
    // The one that a prefix test on a *string* rather than on a path boundary
    // would let through: `…/packages/neo4j-evil` starts with `…/packages/neo4j`.
    const hit = resolvePackageAsset('peek-package://neo4j-evil/index.html', ROOT)
    assert.equal(
      hit?.file,
      `${ROOT}${sep}neo4j-evil${sep}${PACKAGE_UI_DIR}${sep}index.html`,
      'it is its own package, not neo4j',
    )
  })
})

describe('resolvePackageAsset refuses ids and types it was not given', () => {
  test('another scheme, even with a valid-looking path', () => {
    // `protocol.handle` only ever calls this for its own scheme, so this is
    // belt-and-braces — but the function is exported and a second caller is
    // exactly how that assumption stops being true.
    assert.equal(ask('file:///home/me/.peek/packages/neo4j/ui/index.html'), null)
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
    test(`a ${what} package id`, () => {
      assert.equal(ask(`peek-package://${host}/index.html`), null)
    })
  }

  test('an extension with no declared media type', () => {
    // Refused rather than served as octet-stream: the alternative leaves the
    // browser to decide what the file is.
    assert.equal(ask('peek-package://neo4j/data.wasm'), null)
    assert.equal(ask('peek-package://neo4j/LICENSE'), null)
  })
})

describe('the document CSP', () => {
  test('denies the network outright', () => {
    // The single clause the whole Tier C threat model rests on: a package's only
    // I/O is the port. If this ever softens to a host list, the design doc's
    // §2.6 claim stops being true.
    assert.match(PACKAGE_CSP, /connect-src 'none'/)
  })

  test('allows the package its own scripts and nothing inline', () => {
    assert.match(PACKAGE_CSP, /script-src 'self'/)
    assert.ok(!PACKAGE_CSP.includes("script-src 'self' 'unsafe-inline'"), 'inline script must stay refused')
    assert.ok(!PACKAGE_CSP.includes("'unsafe-eval'"), 'eval must stay refused')
  })

  test('starts from deny-all, so a clause nobody wrote is a denial', () => {
    assert.ok(PACKAGE_CSP.startsWith("default-src 'none'"))
  })

  test('cannot nest a frame or navigate away', () => {
    assert.match(PACKAGE_CSP, /frame-src 'none'/)
    assert.match(PACKAGE_CSP, /form-action 'none'/)
    assert.match(PACKAGE_CSP, /base-uri 'none'/)
  })
})

describe('the scheme and the root', () => {
  test('the scheme is what the renderer builds its iframe URL from', () => {
    // `PackageFrame` writes `peek-package://${packageId}` by hand — it cannot import
    // a main-process module — so this constant and that template are the two
    // copies that must agree.
    assert.equal(PACKAGE_SCHEME, 'peek-package')
  })

  test('a package serves its ui/ directory and not the files beside it', () => {
    // The manifest and the two entry modules sit one level above the served
    // root. A frame asking for `peek-package.json` by name gets `ui/` prefixed
    // to it — a file that does not exist — rather than the real manifest, which
    // is the list of every field this package's connect form fills.
    const hit = ask('peek-package://neo4j/peek-package.json')
    assert.equal(hit?.file, `${BASE}${sep}peek-package.json`)
    assert.notEqual(hit?.file, `${ROOT}${sep}neo4j${sep}peek-package.json`)
  })
})
