import type { InstalledPackages } from '@peek/core'

/* ==================================================================
 * One kind of thing a package contributes, and the single place the "is it
 * installed" filter is written.
 *
 * ## The shape this exists to close
 *
 * A package contributes several kinds of thing — a driver, a view kind, an MCP
 * tool — and each kind is summarised in its own table beside this file. Every
 * one of those tables has the same two halves and the same failure: the
 * *declaration* comes off disk with the package, the *implementation* is
 * whatever this build compiled in, and anything compiled in outlives the
 * uninstall. Installing is the easy direction — the new thing appears because
 * the manifest says so. Uninstalling is where a table is wrong, because the
 * compiled-in half is still there and still looks like an answer.
 *
 * That has already cost once: `tools/list` kept offering `expand_node` after
 * neo4j was uninstalled — in that session, in a fresh one, and across a restart
 * with the directory gone (§4sedecies(b), fixed in §4duodevicies). The two
 * sibling tables were filtered and that one was not, and nothing about the three
 * files said which was which.
 *
 * So the filter is not written per table any more. It is written once, in
 * `definePackageContribution` below, and a contribution kind that wants to be
 * offered at all has to go through it. A fourth kind — a package-supplied skill,
 * a context menu — cannot be "the one they forgot to filter", because there is
 * no longer a version of the code that skips the filter to copy from.
 *
 * ## Two types, and why the roster is a third file
 *
 * `PackageContributionGate` deliberately has **no type parameter**. The roster
 * in `contributions.ts` has to hold all of them in one `Record`, and a
 * `PackageContribution<Live>` in that position would make the roster's element
 * type an invariant union that only widens as kinds are added. Everything the
 * guard asks is about *keys* — strings — so the untyped half is the whole of
 * what the roster needs, and `live()` stays on the parameterised interface for
 * the callers that want the values.
 *
 * The roster is a separate module for a chunk reason, not a taste one: it
 * imports `mcpTools.ts`, and this file is imported by `viewKinds.ts`, which the
 * window reaches through `renderer/packages/register.ts`. Merged, every window
 * chunk would carry `@peek/db-neo4j/mcp-tool-meta`.
 * ================================================================== */

/**
 * A contribution kind as the guard sees it: two lists of keys that must agree.
 *
 * `declaredKeys()` is what the installed packages say exists; `liveKeys()` is
 * what this build will actually hand out. They are read at call time rather than
 * captured, because the registry behind them is replaced whenever a package is
 * installed or removed (`packages.install` / `packages.uninstall`, decision 4).
 */
export interface PackageContributionGate {
  /**
   * The `InstalledPackages` list this kind is declared in.
   *
   * Stated rather than inferred from the descriptor's position in the roster, so
   * the guard can pair a gate with the registry list it claims to read and check
   * that `declaredKeys()` is not quietly answering from somewhere else.
   */
  readonly declaredIn: keyof InstalledPackages
  /** What one of these is, in the singular, for the assertion messages. */
  readonly what: string
  /** The keys the installed packages declare — the disk's answer. */
  declaredKeys(): readonly string[]
  /** The keys this build will offer — `live()` reduced to what can be compared. */
  liveKeys(): readonly string[]
}

/** The gate, plus the values behind the keys, for the callers that consume them. */
export interface PackageContribution<Live> extends PackageContributionGate {
  live(): Live[]
}

/**
 * What a contribution kind has to say about itself.
 *
 * `compiled` is required and is the forcing function. An author who could omit
 * it would get an unfiltered list by default, which is exactly the bug — so the
 * question "what did this build compile in for your kind" has to be answered
 * even when the answer is "nothing beyond the registry itself" (both the driver
 * and the tool descriptors answer that today, and say so where they are
 * written).
 *
 * `declaredKeys` is a thunk over no arguments rather than a function of an
 * `InstalledPackages`, so each descriptor reads the accessor its own consumers
 * read — `installedDrivers()`, `installedViewKinds()`, `installedTools()`. Handed
 * the registry instead, those three accessors would have no callers left, and a
 * descriptor could answer from a snapshot nobody else is looking at.
 */
export interface PackageContributionSpec<Live> {
  readonly declaredIn: keyof InstalledPackages
  readonly what: string
  declaredKeys(): readonly string[]
  /** Everything this build could offer, before asking what is installed. */
  compiled(): readonly Live[]
  /** The string both halves are joined by — the manifest's word for one of these. */
  keyOf(entry: Live): string
}

/**
 * A contribution kind, gated.
 *
 * The filter is here and nowhere else. Every kind's `live()` is its compiled-in
 * half minus whatever no installed package declares, so an uninstall removes the
 * offer by construction rather than by each table remembering to check.
 *
 * Silently skipped rather than reported: a package that is not installed is an
 * ordinary state and the manifest is the authority on it. The refusals worth
 * reporting are the other direction — declared and *not* compiled in — and those
 * belong to the modules that would have to run the missing half
 * (`registerPackageViewKindNames`, `build-packages.mjs`).
 */
export function definePackageContribution<Live>(spec: PackageContributionSpec<Live>): PackageContribution<Live> {
  const live = (): Live[] => {
    const declared = new Set(spec.declaredKeys())
    return spec.compiled().filter((entry) => declared.has(spec.keyOf(entry)))
  }
  return {
    declaredIn: spec.declaredIn,
    what: spec.what,
    declaredKeys: () => spec.declaredKeys(),
    live,
    liveKeys: () => live().map((entry) => spec.keyOf(entry)),
  }
}
