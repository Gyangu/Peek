import type { CollectionRef, DriverId } from './capability'
import type { ConnId, ViewId } from './ids'

/* ==================================================================
 * Package-contributed view kinds.
 *
 * ## The shape of the opening, and why it is not "replace the union"
 *
 * `ViewState` is a zod-checked discriminated union over six `kind`s, and seven
 * `switch`es across the repo are exhaustive over it with no `default` — the
 * compiler is what makes a missing branch impossible. The obvious way to let a
 * package add a seventh kind is to replace the union with a registry keyed on a
 * string, and that is what `docs/design/2026-08-03-plugin-architecture.md` §2.3
 * costed: every one of those `switch`es degrades to a table lookup, and every
 * `view.ref` / `view.page` in the codebase degrades to an `unknown` the caller
 * has to re-validate.
 *
 * **That trade is not necessary.** The union gains *one more member* instead:
 *
 *     ViewState = …the six built-ins… | PackageViewState
 *
 * and `PackageViewState.kind` is a branded string rather than a literal. The six
 * built-ins keep their exact types — `view.ref` is still a `CollectionRef`, not
 * a lookup — and every exhaustive `switch` **still fails to compile** until it
 * says what it does with a package view. So the guarantee §2.3 expected to trade
 * away is kept: adding a kind is still a compile error everywhere it matters,
 * and the two call sites that used to degrade silently (`autoFetch`'s
 * `default: return undefined`, `panelTitle`'s template-literal message key) are
 * now forced to be explicit.
 *
 * What the registry holds is therefore **behaviour, not shape**: the answers a
 * built-in gives from a hand-written `case`, a package gives from this record.
 *
 * ## What is deliberately not here
 *
 * The render component and the message catalog. Both are renderer-side, and core
 * has neither React nor an i18n catalog — same split as `DriverManifest` (the
 * shape lives in core, the list lives in the app). The renderer keeps a second
 * registry keyed by the same `kind` string, and a kind that is in one but not the
 * other is a load-time error rather than a blank panel.
 * ================================================================== */

/**
 * The name a package gives its own view kind, e.g. `'documents'`, `'graph'`.
 *
 * A plain string, and **not** the discriminant of `ViewState` — see
 * `PackageViewStateShape.kind` below for why that distinction is the whole trick.
 */
export type PackageViewKindName = string

/**
 * How a package view addresses what it is looking at.
 *
 * Mirrors `TableViewState.ref` in purpose but not in type: a package may browse
 * something that is not one of the three `CollectionRef` kinds, in which case it
 * declares no ref and the collection-shaped affordances (context actions, the
 * browse-style table) simply do not apply to it.
 */
export interface PackageViewRef {
  /** The collection this view browses, when it browses one core already models. */
  collection?: CollectionRef
}

/**
 * The state of a package-contributed view.
 *
 * `state` is opaque to core **on purpose**: its shape is declared by the package
 * and validated against that declaration at the process boundary, exactly once,
 * the same way `KeyValueWindow` is validated by `keyValueReadOptions`. Core never
 * reaches into it; every read goes through the registration's own functions,
 * which are the only code that knows what is in there.
 */
export interface PackageViewStateShape {
  /**
   * **A literal, and that is the point.**
   *
   * The first attempt made this the package's own kind name, branded so it could
   * not be mistaken for a built-in. It compiled, and it silently destroyed every
   * `switch` in the repo: a union member whose discriminant is `string`-based —
   * a brand is still `string` — is not a discriminant at all, so `ViewState`
   * stopped being a discriminated union and `case 'table':` no longer narrowed.
   * The first typecheck after that change reported `Property 'ref' does not
   * exist on type 'ViewState'` **inside `case 'table'`**, which is the compiler
   * saying exactly that.
   *
   * So the discriminant stays a literal and the package's own name moves to
   * `packageKind`. `ViewState` remains a closed, seven-member discriminated
   * union; the openness lives one level in, where it costs nothing.
   */
  kind: 'package'
  /** Which package view this is — `'documents'`, `'graph'`, … */
  packageKind: PackageViewKindName
  connId: ConnId
  state: Readonly<Record<string, unknown>>
  ref?: PackageViewRef
}

/* ------------------------------------------------------------------ */
/* The registration                                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything the kernel needs in order to treat a package view like a built-in
 * one — one entry per call site that used to be a `case`.
 *
 * **Every field is required.** A registration that omits one is rejected at load
 * time by `validateViewKindRegistration`, and the package does not load. That is
 * the compensation for the compile-time exhaustiveness a package kind cannot
 * have: the check moves from `tsc` to load time, and the failure is loud and
 * names the missing field rather than showing up as a panel that never fetches.
 */
export interface ViewKindRegistration<S extends PackageViewStateShape = PackageViewStateShape> {
  kind: PackageViewKindName

  /**
   * The drivers this view kind is for.
   *
   * Without it there is no way to decide whether to *offer* the view on a given
   * connection, and the two available guesses are both wrong: capabilities are
   * far too broad (a `graph` view needs `tabularQuery`, and so does every SQL
   * database), and matching the package's name against the driver id is a
   * coincidence that holds for neo4j and for nothing else.
   *
   * A list rather than a single id because a package may implement more than one
   * driver — `@peek/db-sql` already ships two — and because a view kind can
   * legitimately serve several (a future `graph` over both neo4j and a graph
   * layer on postgres would be one registration, not two).
   */
  driverIds: readonly DriverId[]

  /**
   * One-sentence English description, for `read_workspace` and MCP receipts.
   * **Never localized** — same contract as core's `describeView`, because MCP
   * reads it and a locale-dependent string is not a stable API.
   */
  describe(view: S): string

  /** English fallback title, used when the view carries no explicit `title`. */
  title(view: S): string

  /**
   * The message key for this kind's display name, e.g. `view.kind.documents`.
   *
   * Named rather than derived: `panelTitle.ts` used to build the key with a
   * template literal (`view.kind.${view.kind}`), which for an unregistered kind
   * silently painted the key itself into the tab strip. A declared key can be
   * checked against the catalog at load time.
   */
  titleKey: string

  /**
   * What this view should fetch when it is opened or patched, if anything.
   *
   * `null` means "nothing to fetch" — a legitimate answer (a view that only
   * shows what is already in its state). It is a distinct value from a missing
   * registration precisely because `autoFetch`'s old `default: return undefined`
   * could not tell those two apart, and a package view that silently never
   * fetched was the result.
   */
  autoFetch(view: S): PackageAutoFetch | null

  /** The collection this view addresses, when core models it. */
  collectionRef(view: S): CollectionRef | null
}

/* ------------------------------------------------------------------ */
/* What a registration answers, once it answers from another process    */
/* ------------------------------------------------------------------ */

/**
 * `title(view)` and `describe(view)`, evaluated for one state and carried as data.
 *
 * A pair rather than two fields because they are read together and lose their
 * meaning apart: both describe *the same* state, and a view holding a title from
 * one patch beside a description from another would be worse than holding
 * neither.
 *
 * They exist as data at all because the registration moved out of main (design
 * 2026-08-07 §2.4bis e). `describeView` and `viewTitle` are called by
 * `snapshotWorkspace`, which runs on every patch broadcast and every MCP
 * `read_workspace`; asking another process there would put an IPC round trip on
 * the hottest read path in the app. So they are computed once, before the
 * reducer that changes the state, and stored on the view — see
 * `PackageViewState.packageText`.
 */
export interface PackageViewText {
  /** English fallback title, used when the view carries no explicit `title`. */
  title: string
  /** English one-sentence description, for `read_workspace` and MCP receipts. */
  describe: string
}

/**
 * Everything the kernel needs to know about a package view in a given state.
 *
 * One value because it is one question: `view.open` / `view.update` asks it
 * before reducing, and the three answers travel together so that the round trip
 * happens once. `fetch` is consumed on the spot (it becomes an effect intent, or
 * nothing); the other two are stored.
 */
export interface PackageViewAnswer extends PackageViewText {
  /** `null` is an answer — "this state has nothing to fetch" — not a failure. */
  fetch: PackageAutoFetch | null
}

/**
 * A fetch a package view is asking the kernel to perform on its behalf.
 *
 * Deliberately expressed in the kernel's own vocabulary (a capability plus the
 * request it implies) rather than as a free-form call: the kernel owns result
 * ids, deadlines, backpressure and cancellation, and a package that could issue
 * its own fetch would be outside all four.
 *
 * ## Why the params are typed, when this was first written with an opaque bag
 *
 * The first version was `{capability, params: Record<string, unknown>}` with the
 * comment "opaque to the kernel; handed back to the package's driver verbatim".
 * The first real consumer falsified it: the kernel does not hand a fetch to a
 * driver, it *plans* one — `ctx.plan({type: 'runQuery', text, …})` — and a plan
 * needs the statement text as a string. An opaque bag would have forced main to
 * reach in and hope for `params['text']`, i.e. exactly the unchecked guess this
 * contract exists to prevent. So each capability names its own fields, and the
 * package fills them in the same vocabulary a built-in view uses.
 *
 * ## Why only two capabilities
 *
 * `vectorSearch` and `keyValue` are absent because nothing asks for them yet, and
 * a member added speculatively would be a `case` in main that has never once
 * run. Adding one later is a compile error at the single `switch` that plans
 * these (`handlers/shared.ts`), which is the right place to be reminded.
 */
export type PackageAutoFetch =
  | {
      capability: 'tabularQuery'
      /**
       * The statement, composed by the package's **registration** — which lives in
       * the package and runs in main, not in the package's UI. That distinction is
       * the whole safety story for a self-drawn view: an iframe can patch the
       * view's state, and this function turns that state into a statement, so the
       * iframe never gets to compose one.
       */
      text: string
      /** Bound values. Positional; a driver maps them to whatever its dialect spells. */
      params?: readonly unknown[]
      maxRows?: number
    }
  | {
      capability: 'collectionScan'
      ref: CollectionRef
      offset?: number
      limit?: number
    }

/**
 * How a caller reaches the registration for a package kind.
 *
 * Core declares the shape and takes the lookup as an **optional argument**
 * rather than holding a registry of its own. Two reasons, and the second is the
 * one that decides it:
 *
 * 1. a package depends on core, so core owning the list would close the
 *    dependency graph into a cycle — the same argument that put
 *    `DRIVER_MANIFESTS` in the app rather than in core;
 * 2. a module-level mutable registry inside the frozen contract is exactly the
 *    kind of hidden wire this repository has removed before (`__peekStubCaps`),
 *    and it would make `describeView` — a pure function today — depend on
 *    whether some other module had been imported first.
 *
 * Optional, not required, so that every existing caller keeps working and gets
 * an honest answer (`unregisteredPackageView`) rather than a crash.
 */
export type ViewKindLookup = (packageKind: PackageViewKindName) => ViewKindRegistration | null

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** The fields a registration must carry, named so the error can list them. */
const REQUIRED_FIELDS = [
  'kind',
  'driverIds',
  'describe',
  'title',
  'titleKey',
  'autoFetch',
  'collectionRef',
] as const

export interface ViewKindProblem {
  kind: string
  missing: string[]
}

/**
 * Check one registration, returning the missing field names.
 *
 * Returns a problem rather than throwing: a loader is registering several kinds
 * from several packages, and the useful report is "this package is missing these",
 * not the first exception.
 */
export function validateViewKindRegistration(value: unknown): ViewKindProblem | null {
  const rec = value as Partial<Record<string, unknown>> | null
  if (rec === null || typeof rec !== 'object') {
    return { kind: '(not an object)', missing: [...REQUIRED_FIELDS] }
  }
  const kind = typeof rec['kind'] === 'string' ? rec['kind'] : '(no kind)'
  const missing = REQUIRED_FIELDS.filter((field) => {
    const got = rec[field]
    if (field === 'kind' || field === 'titleKey') return typeof got !== 'string' || got.length === 0
    // An empty array is as missing as no array: a kind no connection can ever
    // offer is a kind that opens from nowhere, which is the same blank-panel
    // failure the rest of these checks exist to prevent.
    if (field === 'driverIds') return !Array.isArray(got) || got.length === 0
    return typeof got !== 'function'
  })
  return missing.length === 0 ? null : { kind, missing: [...missing] }
}
