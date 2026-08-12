import { CollectionRefSchema, type PackageViewAnswer, type PackageAutoFetch } from '@peek/core'
import { packageIdForDriver } from '../../drivers/installed'
import type { PackageViewSource } from '../bus/handlers/view'
import type { PackageHostRegistry } from './registry'

/* ==================================================================
 * What a package view fetches, and what it is called, asked of the package.
 *
 * The sibling of `display.ts`: same registry, same one-question-one-round-trip
 * shape, and the same reason for existing — this used to be a function call in
 * main (`ViewKindRegistration.autoFetch`, straight out of `drivers/viewKinds.ts`)
 * and package code no longer runs in the process that can decrypt every saved
 * credential (design §2.4bis b).
 *
 * The difference is when it is called. A connection is named once, on an
 * operation that was already asynchronous; a view is asked on **every**
 * `view.open` and `view.update`, in front of a reduction that must stay
 * synchronous. That is why the answer carries three things at once (§2.4bis e):
 * `title` and `describe` are read by `snapshotWorkspace` on every patch
 * broadcast, so they are computed here, with the fetch plan, and stored on the
 * view rather than asked for again.
 *
 * ## Which package is asked
 *
 * The one that ships the driver the view is connected to. That is not a shortcut
 * around "which package registered this kind" — it is the same rule read from
 * the same place: a host is `import()`ed its own `contrib.mjs`, whose view kinds
 * declare the `driverIds` they serve, so a view on a neo4j connection is served
 * by exactly the hosts `packageIdForDriver('neo4j')` names. Both ends are the
 * manifest the loader read, which is what keeps them from disagreeing — there is
 * no compiled-in ownership table left for either to drift from.
 * ================================================================== */

export interface PackageViewOptions {
  /**
   * How long a package gets to answer.
   *
   * This is the deadline §2.4bis f-bis rule 1 asks for, and what it bounds is a
   * click: `view.open` cannot reduce until the answer is in, so a package with a
   * runaway `autoFetch` must fail rather than hang. Short, because the work is a
   * pure function over a small object — the only thing that legitimately takes
   * time is the first fork of that package's host, which fits inside it.
   */
  timeoutMs?: number
  /** Where a package's malformed or unanswered question is reported. */
  onError?: (message: string, detail: string) => void
}

const DEFAULT_ANSWER_MS = 5_000

/**
 * Assemble the source the `view.*` handlers prepare against.
 *
 * **Nothing here rejects.** `PackageViewSource` says why: a package that cannot
 * answer must produce a view that does not fetch, not a Command that fails, and
 * the caller is a reduction the user is waiting on. So every failure — no
 * package for the driver, a crashed host, a deadline, an answer that is not the
 * shape it claims — collapses to `null` and is reported through `onError`, which
 * is the only place a human learns that a package went quiet (§2.4bis g: the
 * cost of this design is a package view that "just stops", and attribution is
 * what pays it).
 */
export function createPackageViewSource(
  hosts: PackageHostRegistry,
  options: PackageViewOptions = {},
): PackageViewSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ANSWER_MS
  return {
    async answer(req) {
      const packageId = packageIdForDriver(req.driverId)
      if (packageId === null) return null
      try {
        const raw = await hosts.call(
          packageId,
          'viewAnswer',
          { packageKind: req.view.packageKind, view: req.view },
          timeoutMs,
        )
        const answer = validate(raw)
        if (answer === null) {
          options.onError?.(
            `The ${packageId} package answered with something that is not a view answer.`,
            `kind=${req.view.packageKind}`,
          )
        }
        return answer
      } catch (error) {
        options.onError?.(
          `The ${packageId} package could not say what its ${req.view.packageKind} view should show.`,
          error instanceof Error ? error.message : String(error),
        )
        return null
      }
    },
  }
}

/**
 * Check the answer, because this is the untrusted direction of the boundary.
 *
 * Main is the only sender on the way out; what comes back is a package's own
 * code talking, and it lands in two places that cannot defend themselves. The
 * strings go into `ViewState` and out over MCP, where a non-string surfaces as
 * `[object Object]` in a tab strip. The fetch plan becomes an effect intent — a
 * `runQuery` whose `text` is not a string reaches a driver as a statement, and a
 * `collectionScan` whose `ref` is malformed reaches one as a table name. Neither
 * failure names the package that caused it, which is the whole argument for
 * spending a few `typeof`s here.
 *
 * Returns null for anything that does not check out, so a bad answer is exactly
 * as consequential as no answer.
 */
function validate(raw: unknown): PackageViewAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  if (!('title' in raw) || typeof raw.title !== 'string') return null
  if (!('describe' in raw) || typeof raw.describe !== 'string') return null
  if (!('fetch' in raw)) return null
  const fetch = validateFetch(raw.fetch)
  if (fetch === undefined) return null
  return { fetch, title: raw.title, describe: raw.describe }
}

/** The plan, or `undefined` for one that is not a plan — `null` is the legitimate "nothing to fetch". */
function validateFetch(raw: unknown): PackageAutoFetch | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'object') return undefined
  if (!('capability' in raw)) return undefined
  switch (raw.capability) {
    case 'tabularQuery': {
      if (!('text' in raw) || typeof raw.text !== 'string') return undefined
      const params = optionalList(raw, 'params')
      const maxRows = optionalCount(raw, 'maxRows')
      if (params === undefined || maxRows === undefined) return undefined
      return {
        capability: 'tabularQuery',
        text: raw.text,
        ...(params === null ? {} : { params }),
        ...(maxRows === null ? {} : { maxRows }),
      }
    }
    case 'collectionScan': {
      if (!('ref' in raw)) return undefined
      // The one field with a schema of its own already: a `CollectionRef` is a
      // three-armed union the kernel validates everywhere else it crosses a
      // boundary, and hand-checking it here would be a fourth copy of it.
      const parsed = CollectionRefSchema.safeParse(raw.ref)
      if (!parsed.success) return undefined
      const offset = optionalCount(raw, 'offset')
      const limit = optionalCount(raw, 'limit')
      if (offset === undefined || limit === undefined) return undefined
      return {
        capability: 'collectionScan',
        ref: parsed.data,
        ...(offset === null ? {} : { offset }),
        ...(limit === null ? {} : { limit }),
      }
    }
    // A capability this build does not know is not necessarily a broken package —
    // it may be one written against a newer kernel — but it is a plan nothing
    // here can carry out, and `canFetch` would refuse it a step later anyway.
    default:
      return undefined
  }
}

/**
 * `null` for absent, the value for a valid one, `undefined` for present-and-wrong.
 *
 * Three outcomes rather than two because an absent optional and a broken one are
 * different answers: the first is the package declining to say, the second is a
 * package saying something the kernel cannot act on, and silently dropping the
 * second would run the fetch with a limit nobody asked for.
 */
function optionalCount(raw: object, field: string): number | null | undefined {
  if (!(field in raw)) return null
  const value: unknown = Reflect.get(raw, field)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** As `optionalCount`, for a positional bind list. Its elements stay unknown — the driver binds them. */
function optionalList(raw: object, field: string): readonly unknown[] | null | undefined {
  if (!(field in raw)) return null
  const value: unknown = Reflect.get(raw, field)
  return Array.isArray(value) ? value : undefined
}
