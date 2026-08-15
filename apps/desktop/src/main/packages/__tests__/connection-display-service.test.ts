import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import '../../../drivers/__tests__/in-repo-registry'
import { isPeekError, type ConnectionConfig, type PeekError } from '@peek/core'
import './install-stubs'
import { stubElectron } from './stub-electron'

const { PackageHostRegistry } = await import('../registry')
const { createConnectionDisplayService } = await import('../display')

/* ==================================================================
 * The two kernel rules that stay on main's side of the display boundary.
 *
 * A package computes the three strings; main does not simply forward them. It
 * applies `config.label ||` on top (`labelOf`) and it checks that what came back
 * is three strings (`requireString`) — the two things `display.ts`'s header
 * calls out as deliberate, and neither of them had a test.
 *
 * That gap was not academic. Until §4nonies the `config.label ||` rule existed
 * twice: here, and in `drivers/manifests.ts`'s `connectionLabel`, which no
 * process called. The only assertion on it was pointed at that second copy, so
 * deleting the rule from *this* file left all 1723 tests green. This file is
 * what makes that a red.
 *
 * ## Why the real registry and the real wrapper
 *
 * `lazy-start.test.ts` next door already stands the whole thing up over stubbed
 * Electron, and the answers here have to arrive the way a package's answers
 * arrive — as `unknown` off a message port, because that is the only reason
 * `requireString` exists. A hand-written fake `ConnectionDisplayService` would
 * be a fake of the thing under test; `connection-display.test.ts` in `bus/`
 * legitimately uses one, and it is asserting something else (that whatever this
 * service answers reaches the Workspace).
 * ================================================================== */

/** As `hostFor` requires: an entry point that exists. Its contents never run. */
const hostDir = mkdtempSync(join(tmpdir(), 'peek-display-host-'))
writeFileSync(join(hostDir, 'package-host.js'), '// never executed; utilityProcess is stubbed\n')

const live: InstanceType<typeof PackageHostRegistry>[] = []

after(() => {
  rmSync(hostDir, { recursive: true, force: true })
})

afterEach(async () => {
  for (const hosts of live.splice(0)) await hosts.disposeAll()
  stubElectron.reset()
})

/**
 * A display service whose one package answers every call with `answer`.
 *
 * `answer` is deliberately `unknown`: the whole subject is what main does with a
 * reply it did not write, and typing it as the protocol's own result would let
 * the compiler rule out the cases under test.
 */
function serviceAnswering(answer: unknown): ReturnType<typeof createConnectionDisplayService> {
  stubElectron.answerWith(answer)
  // A contrib path per package, as the scan would answer it: never opened, but a
  // registry with no answer declines to fork and no call reaches the stub.
  const hosts = new PackageHostRegistry({
    hostDir,
    forwardStdio: false,
    resolveContrib: (packageId) => `/peek-packages/${packageId}/contrib.mjs`,
  })
  live.push(hosts)
  return createConnectionDisplayService(hosts, { timeoutMs: 2_000 })
}

/** What a well-behaved `postgres` package answers. */
const GOOD = {
  label: 'orders',
  detail: 'postgres://app@localhost:5432/orders',
  endpoint: 'localhost:5432/orders',
}

const pg = (over: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  driverId: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'orders',
  ...over,
})

/**
 * The structured error a call was refused with.
 *
 * A `try` rather than `assert.rejects`, because `peekError` builds a plain
 * object and not an `Error` — the refusal has to be inspected as a value.
 */
async function refusal(call: Promise<unknown>): Promise<PeekError> {
  try {
    await call
  } catch (err: unknown) {
    assert.ok(isPeekError(err), `expected a structured peek error, got ${String(err)}`)
    return err
  }
  return assert.fail('the call resolved; it was supposed to be refused')
}

/* ------------------------------------------------------------------ */
/* `config.label ||` — the rule that outranks the package                */
/* ------------------------------------------------------------------ */

describe('a name the user typed', () => {
  it('outranks what the package computed', async () => {
    const display = serviceAnswering(GOOD)
    const named = await display.describe({ config: pg({ label: 'staging' }) })

    assert.equal(named.label, 'staging', 'the package renamed a connection its owner had named')
    // Only `label` is the kernel's. The other two are the package's answer
    // verbatim, which is what makes this a rule and not a veto.
    assert.equal(named.detail, GOOD.detail)
    assert.equal(named.endpoint, GOOD.endpoint)
  })

  it('is not the empty one — that is a label the user cleared, not one they chose', async () => {
    // `||` and not `??`. A `??` here would pin the row at the empty string
    // forever, and clearing the field in the connect dialog is how a user asks
    // for the derived name back.
    const display = serviceAnswering(GOOD)
    assert.equal((await display.describe({ config: pg({ label: '' }) })).label, GOOD.label)
  })

  it('costs nothing when the package botches the label it was going to lose anyway', async () => {
    // The short circuit in `labelOf`, asserted rather than left to `||`.
    // `describeConnection` is a soft intent: throwing here would drop the detail
    // and the endpoint too and archive the row unnamed, over a string that was
    // never going to be read.
    const display = serviceAnswering({ ...GOOD, label: 42 })
    const named = await display.describe({ config: pg({ label: 'staging' }) })

    assert.equal(named.label, 'staging')
    assert.equal(named.detail, GOOD.detail, 'the two good strings still arrived')
  })
})

/* ------------------------------------------------------------------ */
/* Three strings, checked — the untrusted direction of the boundary      */
/* ------------------------------------------------------------------ */

describe('what comes back from a package', () => {
  for (const field of ['label', 'detail', 'endpoint'] as const) {
    it(`is refused when ${field} is not a string`, async () => {
      // Unchecked, this reaches `ConnectionState` and surfaces as the sidebar
      // and the MCP receipts saying `[object Object]` — a thing no reader can
      // act on, where the error names the package that did it.
      const display = serviceAnswering({ ...GOOD, [field]: { toString: 'nope' } })
      const err = await refusal(display.describe({ config: pg() }))

      assert.equal(err.code, 'INTERNAL')
      assert.match(err.message, new RegExp(`non-string ${field}`))
      assert.match(err.message, /postgres/, 'the message has to name the package that answered')
    })
  }

  it('is refused when a field is simply missing', async () => {
    // The shape that arrives from a package written against an older protocol,
    // and the one the compiler cannot see: `answer.endpoint` is typed `string`
    // at the call site and is `undefined` here.
    const display = serviceAnswering({ label: GOOD.label, detail: GOOD.detail })
    assert.equal((await refusal(display.describe({ config: pg() }))).code, 'INTERNAL')
  })
})

/* ------------------------------------------------------------------ */
/* And the case that never reaches a package at all                     */
/* ------------------------------------------------------------------ */

it('a driver no installed package ships is a NOT_FOUND, not a crash', async () => {
  // A connection restored from a `connections.json` written by a peek that had
  // a package this one does not. `conn.open` degrades: the row opens unnamed.
  const display = serviceAnswering(GOOD)
  const err = await refusal(display.describe({ config: { driverId: 'mongodb' } }))

  assert.equal(err.code, 'NOT_FOUND')
  assert.match(err.message, /mongodb/)
  assert.equal(stubElectron.forks.length, 0, 'and nothing was forked to find that out')
})
