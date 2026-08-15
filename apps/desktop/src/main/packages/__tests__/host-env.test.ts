import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import './install-stubs'
import { stubElectron } from './stub-electron'

const { PackageHostRegistry } = await import('../registry')

/* ==================================================================
 * Acceptance item 29: nothing credential-shaped reaches a package host.
 *
 * A driver host is handed a plaintext password, because connecting is its job.
 * A package host computes three strings and a fetch plan; it has no job that any
 * secret is an input to. What it does have is arbitrary code from outside this
 * repository (design §2.4bis, decision 6: no signature, no hash, no permission
 * manifest), one `process.env` read away from a developer's whole shell.
 *
 * `spawn-policy.ts` is asserted on its own by `__tests__/hardening.test.ts`.
 * What is asserted *here* is the composition — that this fork actually uses that
 * allowlist, and that the one thing it adds on top adds only itself. That is the
 * half a policy test cannot see, and the half that a plausible edit ("the host
 * needs `NODE_ENV`, I'll just spread `process.env` first") would break while
 * every existing test stayed green.
 *
 * The sentinel is what makes this a check on *values* rather than on names: a
 * variable smuggled through under an innocuous name still carries the secret,
 * and the assertion is that no byte of it crosses.
 * ================================================================== */

const SENTINEL = 'peek-must-not-cross-the-fork-6f3a1c'

/**
 * Names a developer's shell plausibly exports, each set to {@link SENTINEL}.
 *
 * The client-specific ones (`PGPASSWORD`, `MYSQL_PWD`, …) are not hypothetical:
 * they are the fallbacks database clients read *by themselves*, which is why
 * §2.10 removed them from the driver host too — a credential peek never saw.
 */
const HOSTILE_ENV: Readonly<Record<string, string>> = {
  PGPASSWORD: SENTINEL,
  PGUSER: SENTINEL,
  MYSQL_PWD: SENTINEL,
  NEO4J_PASSWORD: SENTINEL,
  REDIS_URL: SENTINEL,
  DATABASE_URL: SENTINEL,
  QDRANT_API_KEY: SENTINEL,
  AWS_ACCESS_KEY_ID: SENTINEL,
  AWS_SECRET_ACCESS_KEY: SENTINEL,
  AWS_SESSION_TOKEN: SENTINEL,
  GITHUB_TOKEN: SENTINEL,
  ANTHROPIC_API_KEY: SENTINEL,
  OPENAI_API_KEY: SENTINEL,
  npm_config__auth: SENTINEL,
  HTTPS_PROXY: `https://user:${SENTINEL}@proxy.internal:8080`,
  SSH_AUTH_SOCK: SENTINEL,
  // Not a credential, but the switch that decides where the *next* host's code
  // is loaded from. Inheriting it would let a package choose that.
  PEEK_DRIVER_HOST_DIR: SENTINEL,
}

const hostDir = mkdtempSync(join(tmpdir(), 'peek-package-env-'))
writeFileSync(join(hostDir, 'package-host.js'), '// never executed; utilityProcess is stubbed\n')

/**
 * Where a package would keep its `contrib.mjs`, as main answers it from the scan.
 *
 * Never opened: `utilityProcess` is the stub, so this is only the string the
 * fork is asked to hand over. It is under a directory of its own rather than
 * inside `hostDir` because the point of the value is that package code lives
 * somewhere other than peek's own bundles.
 */
const resolveContrib = (packageId: string): string => `/peek-packages/${packageId}/contrib.mjs`

after(() => {
  rmSync(hostDir, { recursive: true, force: true })
})

afterEach(() => {
  stubElectron.reset()
})

/** Fork one host with a polluted environment and hand back what the child got. */
async function forkedEnv(packageId: string): Promise<Readonly<Record<string, string>>> {
  const saved = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(HOSTILE_ENV)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
  try {
    const hosts = new PackageHostRegistry({ hostDir, forwardStdio: false, resolveContrib })
    await hosts.hostFor(packageId)
    const record = stubElectron.forks[0]
    assert.ok(record, 'the fork is what this test reads')
    await hosts.disposeAll()
    return record.env
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

describe('the environment a package host is forked with', () => {
  it('carries no value from any credential-shaped variable', async () => {
    const env = await forkedEnv('postgres')

    for (const name of Object.keys(HOSTILE_ENV)) {
      assert.equal(env[name], undefined, `${name} must not reach a package host`)
    }
    // The stronger half: not one of them survived under another name either.
    for (const [name, value] of Object.entries(env)) {
      assert.equal(value.includes(SENTINEL), false, `${name} carries a value that was not meant to cross`)
    }
  })

  it('is an allowlist, so a variable nobody thought of is absent by default', async () => {
    const env = await forkedEnv('postgres')

    // Named rather than derived from ENV_ALLOWLIST: importing that list would
    // make this test agree with whatever it becomes. These are the entries whose
    // presence a package host is entitled to, plus the two peek sets rather than
    // inherits — which package this is, and where its code is.
    const permitted = new Set([
      'PATH',
      'HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TZ',
      'SystemRoot',
      'SystemDrive',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'COMSPEC',
      'PATHEXT',
      'NUMBER_OF_PROCESSORS',
      'WINDIR',
      'PEEK_PACKAGE_ID',
      'PEEK_PACKAGE_ENTRY',
    ])

    const unexpected = Object.keys(env).filter((name) => !permitted.has(name))
    assert.deepEqual(unexpected, [], 'a package host sees only what it was granted')
    // An empty environment would satisfy every assertion above it, and would
    // also be a package host that cannot resolve a binary or find a temp file.
    assert.equal(typeof env['PATH'], 'string', 'the allowlist is applied, not the whole env dropped')
  })

  it('tells the child which package it is and where its code is, and nothing else about peek', async () => {
    const env = await forkedEnv('neo4j')

    assert.equal(env['PEEK_PACKAGE_ID'], 'neo4j')
    // The entry is the value main resolved during the scan, handed over verbatim.
    // A host that derived it instead would be a host choosing its own code, which
    // is the same failure `PEEK_DRIVER_HOST_DIR` is kept off the allowlist for.
    assert.equal(env['PEEK_PACKAGE_ENTRY'], resolveContrib('neo4j'))
    const peekVars = Object.keys(env)
      .filter((name) => name.startsWith('PEEK_'))
      .sort()
    assert.deepEqual(peekVars, ['PEEK_PACKAGE_ENTRY', 'PEEK_PACKAGE_ID'])
  })
})
