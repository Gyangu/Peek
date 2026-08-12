import { peekError, type ConnectionConfig, type DriverId } from '@peek/core'
import { packageIdForDriver } from '../../drivers/installed'
import type { ConnectionDisplayService } from '../bus/deps'
import type { PackageHostRegistry } from './registry'

/* ==================================================================
 * Naming a connection, asked of the package that owns the driver.
 *
 * The three strings used to be a function call in main —
 * `drivers/manifests.ts`'s `connectionLabel` / `connectionDetail` /
 * `endpointSummary`, deleted in §4nonies once this file was the last thing that
 * did what they did. This is the same three strings across a process boundary,
 * and the whole of what changed is *where* they are computed — the config that
 * goes in is still the redacted one, the answer still lands in the Workspace
 * once and is read as a string from then on (design §2.3(b)).
 * ================================================================== */

export interface ConnectionDisplayOptions {
  /**
   * How long a package gets to name a connection.
   *
   * Short on purpose. This is three string concatenations behind a fork; the
   * budget exists so that a package with a runaway `label` cannot hold up the
   * connect it was planned in front of, and it is generous enough that a cold
   * fork fits inside it.
   */
  timeoutMs?: number
}

/** Matches `DEFAULT_TIMEOUTS.rpcMs` in spirit: a control-plane round trip, not a query. */
const DEFAULT_DISPLAY_MS = 5_000

/**
 * Assemble the display service the Command Bus's `describeConnection` effect
 * calls.
 *
 * Two kernel rules stay on this side of the boundary, and neither is an
 * oversight of the protocol:
 *
 *   - **`config.label ||` outranks whatever the package computes.** A name the
 *     *user* typed beats a derived one, and pushing that rule into five packages
 *     would be five chances for one of them to forget it and quietly rename a
 *     connection its owner had named. `connectionLabel` kept it in the kernel for
 *     exactly this reason; moving the derivation out did not move the rule, and
 *     `labelOf` below is now the only place it is written down.
 *   - **The answer is validated.** This is the untrusted direction of the
 *     boundary — main is the only sender on the way out, but what comes back is a
 *     package's code talking. Three strings are cheap to check and a non-string
 *     reaching `ConnectionState` would surface as `[object Object]` in the
 *     sidebar rather than as an error anyone could act on.
 */
export function createConnectionDisplayService(
  hosts: PackageHostRegistry,
  options: ConnectionDisplayOptions = {},
): ConnectionDisplayService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISPLAY_MS
  return {
    async describe(req) {
      const driverId: DriverId = req.config.driverId
      const packageId = packageIdForDriver(driverId)
      if (packageId === null) {
        throw peekError(
          'NOT_FOUND',
          `No package ships driverId=${driverId}, so nothing can name this connection.`,
        )
      }
      const answer = await hosts.call(packageId, 'display', { driverId, config: req.config }, timeoutMs)
      return {
        label: labelOf(req.config, () => requireString(answer.label, 'label', packageId)),
        detail: requireString(answer.detail, 'detail', packageId),
        endpoint: requireString(answer.endpoint, 'endpoint', packageId),
      }
    },
  }
}

/**
 * The kernel's half of a connection's name: what the user typed outranks
 * whatever the package computed. `||` and not `??` — an empty label is a label
 * the user cleared, not one they chose.
 *
 * **The only home of this rule.** `drivers/manifests.ts`'s `connectionLabel`
 * held a second copy until §4nonies, and it was the copy the suite tested — so
 * deleting this line left 1723 tests green. It has its own now.
 *
 * `derive` is a thunk rather than a string because the short circuit is part of
 * the contract and not a side effect of `||`. The caller above validates the
 * package's answer *inside* it, and a package that returns a non-string `label`
 * must not cost a **user-named** connection its name: `describeConnection` is a
 * soft intent, so that throw would take the detail and the endpoint with it and
 * archive the row unnamed, over a field that was never going to be read.
 *
 * Exported for the one test that has to stand in for a package host —
 * `bus/__tests__/connection-book.test.ts` composes the package's half (straight
 * off `DRIVER_DISPLAYS`, which main may not do and a test may) with this half.
 * Calling the rule beats copying it; a copy that drifts stays green.
 */
export function labelOf(config: ConnectionConfig, derive: () => string): string {
  return config.label || derive()
}

function requireString(value: unknown, field: string, packageId: string): string {
  if (typeof value !== 'string') {
    throw peekError('INTERNAL', `Package ${packageId} returned a non-string ${field} for a connection`)
  }
  return value
}
