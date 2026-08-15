import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  peekError,
  peekErrorMsg,
  type NotifyLevel,
  type PackageHostMethod,
  type PackageHostParams,
  type PackageHostResult,
} from '@peek/core'
import { DEFAULT_TIMEOUTS } from '../connections/classify'
import { PackageHostProcess, type PackageId } from './host-process'

/* ==================================================================
 * The pool of package host processes — one per package, **forked on first
 * use**.
 *
 * ## Lazy is the whole point, not an optimisation
 *
 * Design 2026-08-07 §2.4bis(c): "第一次真正需要计算时才 fork。启动路径上零进程".
 * Twenty installed packages must cost twenty *manifests read* at startup and
 * zero processes, because acceptance item 20 (installing 20 packages does not
 * move cold start) cannot survive twenty forks and acceptance item 31 asserts
 * the count directly. `runningCount` exists so that assertion has something to
 * read.
 *
 * What makes it hold is that `hostFor` is the only path to a process and the
 * only caller of `fork`. The split in §2.4bis(d) is what makes it *useful*: MCP
 * `tools/list` and the connect dialog's "which views can this connection open"
 * are answered from manifest data in main, so nothing on those paths ever
 * reaches this class.
 *
 * ## Why a promise is what the map stores
 *
 * `hostFor` is async (`spawn` waits for the process to exist), so two callers
 * arriving in the same tick would otherwise fork twice and leak one of the two.
 * Storing the in-flight promise makes the second caller await the first fork.
 * A failed spawn removes its own entry, so the next call retries rather than
 * inheriting a permanently rejected promise; so does an exit, which is what
 * makes a crashed package host recover on the next call instead of staying dead
 * for the life of the app.
 *
 * ## What this class deliberately does not do
 *
 * It does not know what a package *is* — no manifests, no install directory, no
 * uninstall. It maps an id to a live process and back. The loader that decides
 * which ids exist is a separate concern and calls `dispose(id)` when one goes
 * away.
 * ================================================================== */

/** The bundle electron-vite emits for `src/main/packages/entry.ts`. */
export const PACKAGE_HOST_ENTRY_FILE = 'package-host.js'

export interface PackageHostRegistryOptions {
  /**
   * Where `package-host.js` is loaded from. Defaults to `../package-host`
   * relative to this module's own bundle: main lands in `out/main` and the
   * package host in `out/package-host`, because they are built by two separate
   * Vite passes and a shared `outDir` would mean one emptying the other's output
   * (`electron.vite.package-host.config.ts` has the reasoning). Sibling
   * directories rather than an absolute path so that development and the
   * packaged .app, where the whole `out/` tree is copied wholesale, resolve the
   * same way.
   *
   * Note what is *not* honoured here: `PEEK_DRIVER_HOST_DIR`. That variable is
   * documented (`spawn-policy.ts`) as selecting the **driver** host's entry
   * point, and quietly widening it to a second process type would be the exact
   * failure its own check exists to prevent — changing where credential-adjacent
   * code is loaded from without anyone noticing. If package hosts ever need the
   * same escape hatch it gets its own name, its own `resolveHostDir` call and a
   * line in the design doc.
   */
  hostDir?: string
  /**
   * Where a package keeps its `contrib.mjs`, absolute, or null if it ships none.
   *
   * A callback rather than a table because this class is constructed before
   * anything has read the disk, and the scan that answers it runs inside
   * `app.whenReady()`. It is also the only thing here that knows a package is a
   * *directory* — the class itself still maps an id to a live process and back,
   * and a package with no contrib is a fork it declines rather than one it
   * performs and then apologises for.
   *
   * Defaults to "no package ships one", which makes every `hostFor` fail by
   * name in a process that never installed a scan.
   */
  resolveContrib?: (packageId: PackageId) => string | null
  forwardStdio?: boolean
  /** How long to wait for a forked process to exist. */
  spawnMs?: number
  /** How long to wait for a killed process to be reaped. */
  exitMs?: number
  /** stdout / stderr and exit notices, tagged with the package they came from. */
  onLog?: (packageId: PackageId, level: NotifyLevel, text: string) => void
}

interface HostEntry {
  host: PackageHostProcess
  /** Resolves once the process exists; shared by every concurrent `hostFor`. */
  ready: Promise<PackageHostProcess>
}

export class PackageHostRegistry {
  private readonly entries = new Map<PackageId, HostEntry>()
  private readonly hostDir: string
  private readonly resolveContrib: (packageId: PackageId) => string | null
  private readonly forwardStdio: boolean
  private readonly spawnMs: number
  private readonly exitMs: number
  private readonly onLog: ((packageId: PackageId, level: NotifyLevel, text: string) => void) | null

  constructor(options: PackageHostRegistryOptions = {}) {
    this.hostDir = options.hostDir ?? join(import.meta.dirname, '..', 'package-host')
    this.resolveContrib = options.resolveContrib ?? (() => null)
    this.forwardStdio = options.forwardStdio ?? true
    // Borrowed from the driver budget rather than invented next to it: both
    // numbers answer a question about the OS ("has the process appeared", "has it
    // been reaped") that has nothing to do with which kind of child it is.
    this.spawnMs = options.spawnMs ?? DEFAULT_TIMEOUTS.readyMs
    this.exitMs = options.exitMs ?? DEFAULT_TIMEOUTS.exitMs
    this.onLog = options.onLog ?? null
  }

  /* ---------------------------------------------------------------- */
  /* Inspection                                                        */
  /* ---------------------------------------------------------------- */

  /** How many package hosts are alive. Zero until someone actually calls one. */
  get runningCount(): number {
    return this.entries.size
  }

  runningPackageIds(): PackageId[] {
    return [...this.entries.keys()]
  }

  /* ---------------------------------------------------------------- */
  /* Lazy start                                                        */
  /* ---------------------------------------------------------------- */

  /** The host for a package, forking it if this is the first time anyone asked. */
  hostFor(packageId: PackageId): Promise<PackageHostProcess> {
    const existing = this.entries.get(packageId)
    if (existing) return existing.ready

    const entryPath = join(this.hostDir, PACKAGE_HOST_ENTRY_FILE)
    if (!existsSync(entryPath)) {
      return Promise.reject(
        peekErrorMsg('INTERNAL', 'error.driver.hostBuildMissing', undefined, {
          detail:
            `${entryPath} not found; the package host is built by a pass of its own ` +
            '("pnpm build:package-host"), which `electron-vite build` does not run.',
        }),
      )
    }

    // Asked before the fork, not after: a package with no `contrib.mjs` has
    // nothing this process could compute, and forking it would spend a process to
    // learn that. The message names the package rather than the file, because
    // "this package contributes none of these" is what the caller acted on.
    const contribEntry = this.resolveContrib(packageId)
    if (contribEntry === null) {
      return Promise.reject(
        // A plain literal rather than a catalog key: every way to reach this is a
        // wiring fault in peek or a package directory that vanished mid-session,
        // and neither is something a translated sentence helps a user act on.
        peekError('NOT_FOUND', `The package '${packageId}' is not installed, or ships no contrib entry`),
      )
    }

    const host = new PackageHostProcess(packageId, {
      onExit: (code, expected, detail) => {
        this.forget(packageId, host)
        if (expected) return
        // A package host dying on its own is the case §2.4bis(g) warns reads as
        // "the view just stopped": the in-flight calls already collapsed into a
        // structured error, and this is the part a human can see.
        this.log(
          packageId,
          'error',
          `The package host exited unexpectedly (code ${code}).${detail ? `\n${detail}` : ''}`,
        )
      },
      onStdio: (level, text) => {
        this.log(packageId, level, text)
      },
    })

    const ready = host
      .spawn({ entryPath, contribEntry, spawnMs: this.spawnMs, forwardStdio: this.forwardStdio })
      .then(() => host)
      .catch((err: unknown) => {
        this.forget(packageId, host)
        throw err
      })

    this.entries.set(packageId, { host, ready })
    return ready
  }

  /**
   * One RPC to one package, starting its host if needed.
   *
   * The deadline is the caller's: only the caller knows whether this is a
   * `viewAnswer` blocking a Command reduction or a tool call a model is waiting
   * on (design §2.4bis f-bis, rule 1).
   */
  async call<M extends PackageHostMethod>(
    packageId: PackageId,
    method: M,
    params: PackageHostParams<M>,
    timeoutMs: number,
  ): Promise<PackageHostResult<M>> {
    const host = await this.hostFor(packageId)
    return await host.call(method, params, timeoutMs)
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Kill one package's host.
   *
   * The entry is dropped before the kill, so a `hostFor` racing an uninstall
   * gets a fresh process rather than a handle to one being reaped. It does not
   * wait for the in-flight spawn: those callers are settled by the exit, which
   * rejects them with the same structured error every other crash produces.
   */
  async dispose(packageId: PackageId): Promise<void> {
    const entry = this.entries.get(packageId)
    if (!entry) return
    this.entries.delete(packageId)
    await entry.host.dispose(this.exitMs)
  }

  /** Kill every host. For app quit, and for an uninstall that takes several packages with it. */
  async disposeAll(): Promise<void> {
    await Promise.all(this.runningPackageIds().map((id) => this.dispose(id)))
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /** Drop the entry, but only if it is still the one this host owns — a reconnect may already have replaced it. */
  private forget(packageId: PackageId, host: PackageHostProcess): void {
    if (this.entries.get(packageId)?.host === host) this.entries.delete(packageId)
  }

  private log(packageId: PackageId, level: NotifyLevel, text: string): void {
    this.onLog?.(packageId, level, text)
  }
}
