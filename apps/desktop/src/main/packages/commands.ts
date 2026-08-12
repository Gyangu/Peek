import { join } from 'node:path'
import type {
  NotifyMessage,
  PackageListing,
  PackagesInstallResult,
  PackagesReadResult,
  PackagesRestoreResult,
  PackagesUninstallResult,
  ViewId,
} from '@peek/core'
import { installedPackages } from '../../drivers/installed'
import { fail } from '../bus/failure'
import type { CommandHandlerMap } from '../bus/types'
import { removeConnection } from '../store/mutations'
import { packageLoadNotices } from './installed'
import type { PackageLoadReport } from './loader'
import {
  driverIdsOfPackage,
  installPackage,
  packageListing,
  restoreBundledPackages,
} from './manage'

/* ==================================================================
 * `packages.read` / `packages.install` / `packages.uninstall` / `packages.restore`.
 *
 * The four kernel verbs of design §2.4. They are commands rather than a side
 * channel for the reason `config/handlers.ts` gives about its six: everything
 * asked of main is a command, so these are validated by the same zod gate and
 * land in the same log — "who removed PostgreSQL" is answerable from the same
 * recording as "who moved the MCP port".
 *
 * ## The three paths, and why they are shaped differently
 *
 * §2.7 spells the first two out. What it does not say, because it predates
 * decision 7, is that **none of them loads a line of the package's code**:
 *
 *     install    manifest → full check → kill its package host → replace the
 *                directory → re-scan → tell the windows
 *                → MCP `tools/list_changed`
 *     uninstall  close its connections → close their views → kill its package
 *                host → remove the directory (+ tombstone) → re-scan → tell the
 *                windows → MCP `tools/list_changed`
 *     restore    clear the tombstones → lay the missing bundled ones back out
 *                → re-scan → tell the windows → MCP `tools/list_changed`
 *
 * `driver.mjs` is loaded by a driver host when a connection opens; `contrib.mjs`
 * is loaded by a package host the first time a tool is called or a package view
 * is opened. Both are separate processes, both lazy, and that is why an install
 * can take effect immediately and an uninstall can be complete: there is nothing
 * in main to import and nothing in main to forget (§2.4bis f).
 *
 * **What is lazy still has to be killed.** §2.4bis(f)'s "kill it and it is
 * really gone" was written about uninstall and holds for install word for word:
 * a package host that has already imported `contrib.mjs` keeps answering out of
 * it, so an install that only replaced the files would move the version number
 * everywhere it is *reported* — settings, `packages.read`, `tools/list` — and
 * nowhere it is *computed*. That is why both paths above have the kill in them,
 * and why it sits ahead of the directory in each. Restore has none: it writes
 * only ids that are absent, and nothing absent is running.
 *
 * ## Install and restore are `read`s, uninstall is a `reduce`
 *
 * Installing changes no Workspace state — it adds a row to a registry that lives
 * beside the Workspace, not in it — so it is a `read` handler that does I/O,
 * exactly like `conn.book.forget` and `settings.write`. Restore is the same
 * shape for the same reason, and the asymmetry with uninstall is not an
 * oversight: **only removal can invalidate something the Workspace holds.**
 * Nothing that is open stops being valid because a package appeared.
 *
 * Uninstalling closes the connections whose driver is about to disappear, which
 * *is* Workspace state, so it has to be a reducer, which means it may not do the
 * I/O itself. The disk half leaves as an `uninstallPackage` intent and runs
 * after the `disconnect` intents queued beside it — see `bus/intents.ts`.
 *
 * ## One thing that is honestly out of reach
 *
 * `MCP_INSTRUCTIONS` is fixed when a session sends `initialize`
 * (`mcp/server.ts`), so **a package installed now contributes its skill only to
 * MCP sessions opened later**. That is the protocol, not an implementation
 * shortcut: `tools/list_changed` exists, an equivalent for instructions does
 * not. §2.7 records it as one of the two things hot loading cannot do, and
 * nothing here pretends otherwise — the tool list of a live session is corrected,
 * its instructions are not.
 * ================================================================== */

export interface PackageCommandOptions {
  /** `<configDir>/packages`. */
  readonly packagesRoot: string
  /**
   * Where this build keeps the copies it ships, for `packages.restore`.
   *
   * The path, not the catalog below, because restoring copies directories while
   * the catalog only answers questions about versions. It is held for the same
   * reason: the app bundle cannot move while the process running out of it is
   * alive.
   */
  readonly bundledRoot: string
  /**
   * What this build ships, as id → version (`bundledCatalog`).
   *
   * Read **once**, at assembly, and held: the app bundle cannot change while the
   * process that is running out of it is alive, and an app upgrade is a new
   * process reading it again. Holding it is what keeps "is this id one peek
   * ships" — the question that decides whether an uninstall leaves a tombstone —
   * answerable inside a reducer, where a disk read is not allowed.
   */
  readonly catalog: ReadonlyMap<string, string>
  /** Read the packages root and report what is there. Registers nothing. */
  scan(): PackageLoadReport
  /** Make a scan the registry every process reads, and hand it to the windows. */
  adopt(report: PackageLoadReport): void
  /** Tell every live MCP session that its tool list moved. */
  toolsChanged(): void
  notify(message: NotifyMessage): void
}

/**
 * @param disposeHost Kill one package's host process. A second parameter rather
 * than a `PackageCommandOptions` field for the reason the 2026-08-11 design gave
 * about `createPackageAdmin`, which takes the identical one: `options` is the
 * assembly the four verbs share, and killing a process is something only two of
 * them ever do. Main hands both functions the same wrapper.
 */
export function createPackageHandlers(
  options: PackageCommandOptions,
  disposeHost: (packageId: string) => Promise<void>,
): CommandHandlerMap {
  const { catalog } = options

  function listing(): PackageListing[] {
    return packageListing(installedPackages(), catalog)
  }

  /**
   * Say, in `packageLoadNotices`'s words, what the scan made of what this
   * command just wrote.
   *
   * `adopt` alone is not enough: a package can be copied in successfully and
   * still be refused by the scan that follows — two packages laid out in one
   * pass that claim the same driver, or a directory that appeared beside this
   * one since the check ran — and until this existed that refusal went into a
   * `PackageLoadReport` nobody read. The command then answered with a success
   * receipt naming a package that is not in the list beside it, which is design
   * §4.2 item 10 failing in the one way it is not allowed to: silently.
   *
   * Filtered to `ids` on the same grounds the install path already applied to
   * warnings — re-announcing every pre-existing one would bury the one that
   * belongs to what just happened — but by filtering the *report* rather than
   * the messages, so the wording of a refusal stays in the single place that
   * owns it. `loaded` is passed through whole: the "nothing is installed" line
   * is a statement about the directory, and after a verb that claims to have
   * added something to it, it is exactly the line worth having.
   */
  function noticesFor(report: PackageLoadReport, ids: ReadonlySet<string>): NotifyMessage[] {
    return packageLoadNotices(
      {
        loaded: report.loaded,
        refused: report.refused.filter((entry) => ids.has(entry.id)),
        warnings: report.warnings.filter((entry) => ids.has(entry.id)),
      },
      options.packagesRoot,
    )
  }

  return {
    'packages.read': {
      read: (): PackagesReadResult => ({ packages: listing() }),
    },

    'packages.install': {
      read: async (_state, input): Promise<PackagesInstallResult> => {
        // Measured against the disk rather than against the registry: the
        // registry is what the *last* scan found, and the collision checks below
        // are about what is there now. A package hand-copied into the directory
        // since startup is exactly the case where the two differ, and it is not
        // a rare one — it is how this fixture-driven verification works.
        const before = options.scan()

        const outcome = await installPackage({
          // The one place the two spellings of "which directory" become one.
          // `bundledId` is resolved here rather than in `manage.ts` because the
          // bundle root is a fact about this process, and `installPackage` is
          // deliberately drivable against a temporary directory with no app
          // around it.
          sourceDir: 'dir' in input ? input.dir : join(options.bundledRoot, input.bundledId),
          packagesRoot: options.packagesRoot,
          loaded: before.loaded,
          // The id is the manifest's, which only `installPackage` has resolved
          // by the time this is called — a directory named `echo-1.0.0`
          // installs, and has to be killed, as `echo`.
          evict: disposeHost,
        })
        if (!outcome.ok) {
          // Every issue, not the first: `loader.ts` collects them precisely so a
          // manifest with four things wrong takes one round of fixing, and the
          // caller here is a person who is about to go and edit that file.
          fail(
            'BAD_REQUEST',
            `'${outcome.id}' was not installed:\n${outcome.issues.map((issue) => `  ${issue}`).join('\n')}`,
          )
        }

        const after = options.scan()
        options.adopt(after)

        // After `adopt`, so a client that asks for the tool list on hearing this
        // is answered from the registry that now includes the package.
        options.toolsChanged()

        for (const notice of noticesFor(after, new Set([outcome.id]))) options.notify(notice)

        return {
          id: outcome.id,
          version: outcome.version,
          replaced: outcome.replaced,
          packages: listing(),
        }
      },
    },

    'packages.uninstall': {
      reduce(draft, input, ctx) {
        const installed = installedPackages()
        const row = listing().find((entry) => entry.id === input.id)
        if (!row) {
          // English rather than a catalog key, on the same grounds as
          // `knownConfig` in handlers/conn.ts: the surfaces that can reach this
          // are an MCP caller and a settings panel racing its own list, and for
          // both the id and the reason are the whole message.
          fail('NOT_FOUND', `No package is installed under the id '${input.id}'`)
        }

        // Read from the registry, not from the connections: a connection stores a
        // `driverId` and nothing about which package answers for it, and after the
        // scan below there would be no way left to ask.
        const driverIds = new Set(driverIdsOfPackage(installed, input.id))
        const closedConnIds = Object.values(draft.connections)
          .filter((conn) => driverIds.has(conn.driverId))
          .map((conn) => conn.id)

        const closedViewIds: ViewId[] = []
        for (const connId of closedConnIds) {
          // `closeViews: true`, which is what §2.7 step 2 amounts to in practice:
          // every view of this package hangs off one of its connections, so
          // closing them takes the package's views with them. A view that somehow
          // outlives its connection degrades to `view.packageMissing` once the
          // window drops the kind — an explicit panel, not a blank one, which is
          // acceptance 13.
          const removed = removeConnection(draft, connId, true)
          closedViewIds.push(...removed.closedViewIds)
          for (const resultId of removed.abortedResultIds) {
            ctx.plan({ type: 'cancel', connId, resultId, soft: true })
          }
          ctx.plan({ type: 'disconnect', connId, soft: true })
        }

        // Last, so every driver host is already being torn down before the
        // `driver.mjs` it loaded leaves the disk.
        ctx.plan({ type: 'uninstallPackage', packageId: input.id, version: row.version })

        const result: PackagesUninstallResult = {
          id: input.id,
          closedConnIds,
          closedViewIds,
          tombstoned: catalog.has(input.id),
          // Corrected below. The reducer cannot answer it: the directory is still
          // there and the registry still holds the package until the effect runs.
          packages: [],
        }
        return result
      },

      finalize: (data): PackagesUninstallResult => ({ ...data, packages: listing() }),
    },

    'packages.restore': {
      read: (): PackagesRestoreResult => {
        const outcome = restoreBundledPackages({
          packagesRoot: options.packagesRoot,
          bundledRoot: options.bundledRoot,
        })
        // Before the re-scan, because this is the one failure with no package to
        // blame: `~/.peek/packages` is a regular file, or peek was once started
        // under `sudo` and cannot write there now. Nothing was laid out, so the
        // registry cannot have moved, and the sentence `restoreBundledPackages`
        // wrote is the whole of what there is to say. Reported as the command's
        // failure rather than as `{restored: []}` for the reason
        // `unavailablePackageHandlers` gives: that reply is byte-for-byte the one
        // a working peek gives when nothing was missing.
        if (!outcome.ok) fail('INTERNAL', outcome.issue)

        // Unconditionally, even when nothing was laid out. The tombstone file
        // changed on every press — that is what makes the *next* start behave —
        // and a caller cannot tell an empty `restored` from a no-op otherwise.
        // The re-scan is cheap and the alternative is a branch whose wrong side
        // is a window showing a package that is no longer suppressed as though
        // it still were.
        const after = options.scan()
        options.adopt(after)
        options.toolsChanged()

        // Only the packages this press brought back — see `noticesFor`. The
        // refusals matter more here than anywhere: `restored` names a directory
        // that was written, and a package the scan then refused is a name in a
        // success receipt with nothing behind it.
        for (const notice of noticesFor(after, new Set(outcome.restored))) options.notify(notice)

        return {
          restored: [...outcome.restored],
          failed: outcome.failed.map((entry) => ({ id: entry.id, detail: entry.detail })),
          packages: listing(),
        }
      },
    },
  }
}

/**
 * What the four verbs answer before anything has been assembled.
 *
 * The analogue of `unavailableConfigHandlers`, registered by `coreHandlers` and
 * overwritten by `bus.registerAll(createPackageHandlers(...))` during assembly.
 * A bus in this state is one with no packages root to read, so the honest answer
 * to `packages.read` is an empty list — which is also the answer a real peek
 * gives when `~/.peek/packages/` is empty, so no consumer needs a second case.
 *
 * The three writing verbs fail rather than pretending. `packages.uninstall`
 * would anyway (its intent has no `PackageAdminService` to reach), and having
 * the other two agree with it keeps "this peek cannot manage packages" one
 * answer instead of three. `packages.restore` in particular must not answer
 * `{restored: []}` here: that is the same reply a working peek gives when
 * nothing was missing, and the two mean opposite things.
 */
export const unavailablePackageHandlers = {
  'packages.read': {
    read: (): PackagesReadResult => ({ packages: [] }),
  },
  'packages.install': {
    read: (): PackagesInstallResult => fail('INTERNAL', 'This peek cannot install packages'),
  },
  'packages.uninstall': {
    read: (): PackagesUninstallResult => fail('INTERNAL', 'This peek cannot uninstall packages'),
  },
  'packages.restore': {
    read: (): PackagesRestoreResult => fail('INTERNAL', 'This peek cannot restore packages'),
  },
} satisfies CommandHandlerMap
