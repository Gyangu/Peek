import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { allowedEnv, resolveHostDir } from '../connections/spawn-policy'
import { isExternalLink } from '../external-link'
import { PACKAGE_CSP, PACKAGE_SCHEME_PRIVILEGES } from '../packages/assets'

/* ==================================================================
 * The Electron hardening batch — design 2026-08-07 §2.10, verification §4.8.
 *
 * One file, because §4.8 requires this batch to be runnable on its own: it
 * landed in the same change as the database-package work and has no causal
 * connection to it, so when something breaks, "which half" has to be one command
 * away.
 *
 * Every check here has a **reverse** case beside it. Three of these guard
 * properties that fail silently — an env variable that leaks, a privilege
 * flipped to true, a scheme that quietly serves — so a check that could not fail
 * would be worse than none: it would read as coverage.
 * ================================================================== */

describe('the driver host inherits an allowlist, not the environment', () => {
  it('drops credentials, tokens and everything else not named', () => {
    const env = allowedEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      AWS_SECRET_ACCESS_KEY: 'shhh',
      GITHUB_TOKEN: 'ghp_x',
      PGPASSWORD: 'hunter2',
      HTTPS_PROXY: 'http://user:pw@proxy',
      npm_config_registry: 'https://registry',
    })
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/Users/x' })
  })

  it('does not pass on the variable that relocates the host itself', () => {
    // The other half of the check in `resolveHostDir`: a driver host must not be
    // able to choose where the next one loads from.
    const env = allowedEnv({ PATH: '/usr/bin', PEEK_DRIVER_HOST_DIR: '/tmp/evil' })
    assert.equal(env['PEEK_DRIVER_HOST_DIR'], undefined)
  })

  it('does not pass on ELECTRON_RUN_AS_NODE', () => {
    // Belt and braces with the `RunAsNode` fuse: the fuse stops the binary from
    // honouring it, this stops it from being handed down in the first place.
    const env = allowedEnv({ ELECTRON_RUN_AS_NODE: '1' })
    assert.deepEqual(env, {})
  })

  it('keeps an empty string, which is a value and not an absence', () => {
    // `TZ=` is meaningful (UTC on some platforms); filtering on truthiness
    // rather than on type would silently change the timestamps a driver renders.
    assert.deepEqual(allowedEnv({ TZ: '' }), { TZ: '' })
  })

  it('omits a name that is absent rather than setting it to undefined', () => {
    // `ForkOptions.env` rejects undefined values outright.
    const env = allowedEnv({})
    assert.deepEqual(Object.keys(env), [])
  })
})

describe('PEEK_DRIVER_HOST_DIR is checked, and never silent', () => {
  const DEFAULT = '/app/out/main'

  it('is ignored entirely in a packaged build, and says so', () => {
    const got = resolveHostDir(DEFAULT, { PEEK_DRIVER_HOST_DIR: '/tmp/elsewhere' }, false)
    assert.equal(got.dir, DEFAULT)
    assert.match(String(got.note), /packaged build/)
  })

  it('refuses a relative path', () => {
    const got = resolveHostDir(DEFAULT, { PEEK_DRIVER_HOST_DIR: 'out/main' }, true)
    assert.equal(got.dir, DEFAULT)
    assert.match(String(got.note), /absolute/)
  })

  it('refuses a path that does not exist', () => {
    const got = resolveHostDir(DEFAULT, { PEEK_DRIVER_HOST_DIR: '/nope/not/here' }, true)
    assert.equal(got.dir, DEFAULT)
    assert.match(String(got.note), /does not exist/)
  })

  it('accepts an absolute existing directory — and still reports it', () => {
    // The accepted case matters most: the risk this variable poses is that it
    // moves the plaintext-password process *quietly*, so a silent success would
    // keep exactly the half worth fixing.
    const got = resolveHostDir(DEFAULT, { PEEK_DRIVER_HOST_DIR: '/tmp' }, true)
    assert.equal(got.dir, '/tmp')
    assert.notEqual(got.note, null)
  })

  it('says nothing at all when the variable is unset', () => {
    assert.deepEqual(resolveHostDir(DEFAULT, {}, true), { dir: DEFAULT, note: null })
    assert.deepEqual(resolveHostDir(DEFAULT, { PEEK_DRIVER_HOST_DIR: '' }, true), {
      dir: DEFAULT,
      note: null,
    })
  })
})

describe('only http(s) is handed to the system browser', () => {
  it('accepts the two schemes a browser is for', () => {
    assert.equal(isExternalLink('https://example.com/docs'), true)
    assert.equal(isExternalLink('http://localhost:5432'), true)
  })

  it('refuses the schemes that would make openExternal a local-open primitive', () => {
    for (const url of [
      'file:///Users/x/.ssh/id_rsa',
      'peek-package://neo4j/index.html',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vscode://file/etc/passwd',
      'smb://server/share',
    ]) {
      assert.equal(isExternalLink(url), false, url)
    }
  })

  it('refuses something that is not a URL at all', () => {
    assert.equal(isExternalLink('not a url'), false)
    assert.equal(isExternalLink(''), false)
  })
})

describe('the package scheme stays as narrow as it was', () => {
  it('grants an origin, and nothing that reaches the network', () => {
    assert.equal(PACKAGE_SCHEME_PRIVILEGES.standard, true)
    assert.equal(PACKAGE_SCHEME_PRIVILEGES.secure, true)
    // These three are the ones the usual recipe turns on. A package frame has no
    // network by design; turning any of them on would be a hole nothing else in
    // the build would notice.
    assert.equal(PACKAGE_SCHEME_PRIVILEGES.supportFetchAPI, false)
    assert.equal(PACKAGE_SCHEME_PRIVILEGES.corsEnabled, false)
    assert.equal(PACKAGE_SCHEME_PRIVILEGES.allowServiceWorkers, false)
  })

  it('states the same rule a second time in the document CSP', () => {
    // Two mechanisms, deliberately: a header can be got wrong in `assets.ts`, a
    // privilege cannot be got wrong from inside the frame.
    assert.match(PACKAGE_CSP, /connect-src 'none'/)
    assert.match(PACKAGE_CSP, /default-src 'none'/)
    assert.match(PACKAGE_CSP, /frame-src 'none'/)
  })
})
