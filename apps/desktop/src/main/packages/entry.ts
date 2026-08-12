import { pathToFileURL } from 'node:url'
import { startPackageHostProcess, type PackageHostRuntimeOptions } from '@peek/core'

/**
 * The package host process entry (an Electron utilityProcess entry, design
 * 2026-08-07 §2.4bis).
 *
 * One package = one utilityProcess, forked the first time anyone needs a value
 * only that package can compute. It answers four questions and holds nothing:
 * the three display strings for a connection, a view kind's fetch plan plus its
 * title and description, that view's `CollectionRef`, and one MCP tool call.
 *
 * Like `driver-host/entry.ts`, this file does exactly one thing — hand the
 * package's contributions to the runtime. The protocol and the runtime both live
 * in core's `package-host.ts`, which imports no Electron and is therefore
 * unit-testable over an ordinary `MessageChannel`; everything Electron-specific
 * stops at `process.parentPort`, a MessagePortMain that happens to satisfy
 * core's `PackageHostChannel` structurally.
 *
 * There is a single `package-host.js` output shared by every package, because
 * which package *this* process is comes from `PEEK_PACKAGE_ID`, set by the fork.
 * It is built by `electron.vite.package-host.config.ts` — a Vite pass separate
 * from the one that builds main, because two entries in one Rollup graph share
 * chunks and that is exactly what §2.4bis(a) forbids.
 *
 * ## Phase C: the contributions come off disk
 *
 * `PEEK_PACKAGE_ENTRY` is an absolute path to this package's `contrib.mjs`,
 * resolved and checked by `loadPackages` and handed over by the fork in
 * `packages/host-process.ts`. Until §4quaterdecies this file sliced three static
 * aggregates in `src/drivers/` instead, which was Phase B: a package was a
 * workspace directory the app happened to `import`, and every package host
 * therefore carried all five packages' display, view and tool code in one
 * bundle. Both costs go away with the same edit — the bundle is now core and
 * nothing else, and a package that is not compiled in is no longer a package
 * that cannot be loaded.
 *
 * This process does not derive the path, search for it, or fall back. See
 * `driver-host/entry.ts` for why: a host that chooses its own code makes the
 * spawn policy decorative.
 */

/**
 * What a `contrib.mjs` exports, checked as a shape and no further.
 *
 * All three keys are optional in `PackageHostRuntimeOptions` and absent is the
 * spelling for "this package contributes none" (`db-postgres` exports only
 * `displays`), so there is nothing here that a module must have — which is why
 * this validates the *containers* and leaves their contents to the runtime,
 * which fails per lookup and can therefore say which display or which tool was
 * asked for.
 */
function contribOf(mod: unknown, entry: string): PackageHostRuntimeOptions {
  if (typeof mod !== 'object' || mod === null) throw new Error(`${entry} did not evaluate to a module`)
  // Spelled out three times rather than looped: `key in mod` narrows the value
  // only for a literal key, and a loop over the union would need a cast to read
  // the property back off.
  const options: PackageHostRuntimeOptions = {}
  if ('displays' in mod && mod.displays !== undefined) {
    if (!Array.isArray(mod.displays)) throw new Error(`${entry} exports 'displays', but it is not an array`)
    options.displays = mod.displays
  }
  if ('viewKinds' in mod && mod.viewKinds !== undefined) {
    if (!Array.isArray(mod.viewKinds)) throw new Error(`${entry} exports 'viewKinds', but it is not an array`)
    options.viewKinds = mod.viewKinds
  }
  if ('tools' in mod && mod.tools !== undefined) {
    if (!Array.isArray(mod.tools)) throw new Error(`${entry} exports 'tools', but it is not an array`)
    options.tools = mod.tools
  }
  return options
}

/** What this package contributes. */
async function loadContrib(): Promise<PackageHostRuntimeOptions> {
  const entry = process.env['PEEK_PACKAGE_ENTRY']
  if (entry === undefined || entry === '') {
    throw new Error('PEEK_PACKAGE_ENTRY is not set; a package host must be told what to load')
  }
  // `pathToFileURL`, not the bare path: an absolute Windows path is not a valid
  // ESM specifier, and a relative-looking one would resolve against this bundle.
  return contribOf(await import(pathToFileURL(entry).href), entry)
}

/**
 * Which package this process is.
 *
 * The env variable is authoritative and the argument is the readable copy — the
 * same pairing `DriverHostProcess` uses for `--conn` / `--driver`, and it is what
 * makes `ps` legible next to `serviceName: peek-package-<id>`.
 *
 * Read for its own sake now that the contributions arrive by path: nothing here
 * looks a package up by id any more, and a host whose id and entry disagreed
 * would be a fork bug worth failing on rather than a lookup that quietly wins.
 */
function resolvePackageId(): string {
  const fromEnv = process.env['PEEK_PACKAGE_ID']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const flag = process.argv.find((arg) => arg.startsWith('--package='))
  if (flag !== undefined) return flag.slice('--package='.length)
  throw new Error('PEEK_PACKAGE_ID is not set; a package host must be told which package it is')
}

async function main(): Promise<void> {
  resolvePackageId()
  // Awaiting before the runtime attaches is safe: `parentPort` queues incoming
  // messages until something starts listening, which is the same property core's
  // header leans on when it says the first response *is* the handshake.
  startPackageHostProcess(await loadContrib())
}

main().catch((err: unknown) => {
  // Dying here is the right answer, not a fallback: a host with no contributions
  // would answer every request with NOT_FOUND, and main would have no way to tell
  // that from a package that genuinely contributes nothing. Exiting collapses the
  // in-flight calls into a structured crash instead. stderr is the only channel a
  // package host has — main's wrapper forwards it.
  console.error(
    `[peek/error] The package host could not load its contributions: ${err instanceof Error ? err.message : String(err)}`,
  )
  process.exit(1)
})
