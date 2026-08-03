import type { CollectionRef, DriverId } from './capability'
import type { ConnId, ViewId } from './ids'

/* ==================================================================
 * Plugin-contributed view kinds.
 *
 * ## The shape of the opening, and why it is not "replace the union"
 *
 * `ViewState` is a zod-checked discriminated union over six `kind`s, and seven
 * `switch`es across the repo are exhaustive over it with no `default` — the
 * compiler is what makes a missing branch impossible. The obvious way to let a
 * plugin add a seventh kind is to replace the union with a registry keyed on a
 * string, and that is what `docs/design/2026-08-03-plugin-architecture.md` §2.3
 * costed: every one of those `switch`es degrades to a table lookup, and every
 * `view.ref` / `view.page` in the codebase degrades to an `unknown` the caller
 * has to re-validate.
 *
 * **That trade is not necessary.** The union gains *one more member* instead:
 *
 *     ViewState = …the six built-ins… | PluginViewState
 *
 * and `PluginViewState.kind` is a branded string rather than a literal. The six
 * built-ins keep their exact types — `view.ref` is still a `CollectionRef`, not
 * a lookup — and every exhaustive `switch` **still fails to compile** until it
 * says what it does with a plugin view. So the guarantee §2.3 expected to trade
 * away is kept: adding a kind is still a compile error everywhere it matters,
 * and the two call sites that used to degrade silently (`autoFetch`'s
 * `default: return undefined`, `panelTitle`'s template-literal message key) are
 * now forced to be explicit.
 *
 * What the registry holds is therefore **behaviour, not shape**: the answers a
 * built-in gives from a hand-written `case`, a plugin gives from this record.
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
 * The name a plugin gives its own view kind, e.g. `'documents'`, `'graph'`.
 *
 * A plain string, and **not** the discriminant of `ViewState` — see
 * `PluginViewStateShape.kind` below for why that distinction is the whole trick.
 */
export type PluginViewKind = string

/**
 * How a plugin view addresses what it is looking at.
 *
 * Mirrors `TableViewState.ref` in purpose but not in type: a plugin may browse
 * something that is not one of the three `CollectionRef` kinds, in which case it
 * declares no ref and the collection-shaped affordances (context actions, the
 * browse-style table) simply do not apply to it.
 */
export interface PluginViewRef {
  /** The collection this view browses, when it browses one core already models. */
  collection?: CollectionRef
}

/**
 * The state of a plugin-contributed view.
 *
 * `state` is opaque to core **on purpose**: its shape is declared by the plugin
 * and validated against that declaration at the process boundary, exactly once,
 * the same way `KeyValueWindow` is validated by `keyValueReadOptions`. Core never
 * reaches into it; every read goes through the registration's own functions,
 * which are the only code that knows what is in there.
 */
export interface PluginViewStateShape {
  /**
   * **A literal, and that is the point.**
   *
   * The first attempt made this the plugin's own kind name, branded so it could
   * not be mistaken for a built-in. It compiled, and it silently destroyed every
   * `switch` in the repo: a union member whose discriminant is `string`-based —
   * a brand is still `string` — is not a discriminant at all, so `ViewState`
   * stopped being a discriminated union and `case 'table':` no longer narrowed.
   * The first typecheck after that change reported `Property 'ref' does not
   * exist on type 'ViewState'` **inside `case 'table'`**, which is the compiler
   * saying exactly that.
   *
   * So the discriminant stays a literal and the plugin's own name moves to
   * `pluginKind`. `ViewState` remains a closed, seven-member discriminated
   * union; the openness lives one level in, where it costs nothing.
   */
  kind: 'plugin'
  /** Which plugin view this is — `'documents'`, `'graph'`, … */
  pluginKind: PluginViewKind
  connId: ConnId
  state: Readonly<Record<string, unknown>>
  ref?: PluginViewRef
}

/* ------------------------------------------------------------------ */
/* The registration                                                    */
/* ------------------------------------------------------------------ */

/**
 * Everything the kernel needs in order to treat a plugin view like a built-in
 * one — one entry per call site that used to be a `case`.
 *
 * **Every field is required.** A registration that omits one is rejected at load
 * time by `validateViewKindRegistration`, and the plugin does not load. That is
 * the compensation for the compile-time exhaustiveness a plugin kind cannot
 * have: the check moves from `tsc` to load time, and the failure is loud and
 * names the missing field rather than showing up as a panel that never fetches.
 */
export interface ViewKindRegistration<S extends PluginViewStateShape = PluginViewStateShape> {
  kind: PluginViewKind

  /**
   * The drivers this view kind is for.
   *
   * Without it there is no way to decide whether to *offer* the view on a given
   * connection, and the two available guesses are both wrong: capabilities are
   * far too broad (a `graph` view needs `tabularQuery`, and so does every SQL
   * database), and matching the plugin's name against the driver id is a
   * coincidence that holds for neo4j and for nothing else.
   *
   * A list rather than a single id because a package may implement more than one
   * driver — `@peek/driver-sql` already ships two — and because a view kind can
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
   * could not tell those two apart, and a plugin view that silently never
   * fetched was the result.
   */
  autoFetch(view: S): PluginAutoFetch | null

  /** The collection this view addresses, when core models it. */
  collectionRef(view: S): CollectionRef | null
}

/**
 * A fetch a plugin view is asking the kernel to perform on its behalf.
 *
 * Deliberately expressed in the kernel's own vocabulary (a capability plus the
 * request it implies) rather than as a free-form call: the kernel owns result
 * ids, deadlines, backpressure and cancellation, and a plugin that could issue
 * its own fetch would be outside all four.
 *
 * ## Why the params are typed, when this was first written with an opaque bag
 *
 * The first version was `{capability, params: Record<string, unknown>}` with the
 * comment "opaque to the kernel; handed back to the plugin's driver verbatim".
 * The first real consumer falsified it: the kernel does not hand a fetch to a
 * driver, it *plans* one — `ctx.plan({type: 'runQuery', text, …})` — and a plan
 * needs the statement text as a string. An opaque bag would have forced main to
 * reach in and hope for `params['text']`, i.e. exactly the unchecked guess this
 * contract exists to prevent. So each capability names its own fields, and the
 * plugin fills them in the same vocabulary a built-in view uses.
 *
 * ## Why only two capabilities
 *
 * `vectorSearch` and `keyValue` are absent because nothing asks for them yet, and
 * a member added speculatively would be a `case` in main that has never once
 * run. Adding one later is a compile error at the single `switch` that plans
 * these (`handlers/shared.ts`), which is the right place to be reminded.
 */
export type PluginAutoFetch =
  | {
      capability: 'tabularQuery'
      /**
       * The statement, composed by the plugin's **registration** — which lives in
       * the package and runs in main, not in the plugin's UI. That distinction is
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
 * How a caller reaches the registration for a plugin kind.
 *
 * Core declares the shape and takes the lookup as an **optional argument**
 * rather than holding a registry of its own. Two reasons, and the second is the
 * one that decides it:
 *
 * 1. a plugin package depends on core, so core owning the list would close the
 *    dependency graph into a cycle — the same argument that put
 *    `DRIVER_MANIFESTS` in the app rather than in core;
 * 2. a module-level mutable registry inside the frozen contract is exactly the
 *    kind of hidden wire this repository has removed before (`__peekStubCaps`),
 *    and it would make `describeView` — a pure function today — depend on
 *    whether some other module had been imported first.
 *
 * Optional, not required, so that every existing caller keeps working and gets
 * an honest answer (`unregisteredPluginView`) rather than a crash.
 */
export type ViewKindLookup = (pluginKind: PluginViewKind) => ViewKindRegistration | null

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
 * from several plugins, and the useful report is "this plugin is missing these",
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
