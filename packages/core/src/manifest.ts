import type { Capability, ConnectionConfig, DriverId } from './capability'

/* ==================================================================
 * DriverManifest — what a database *is*, as opposed to what it does.
 *
 * A driver package has two halves that belong in different processes:
 *
 *   the driver    `@peek/driver-x`, which imports pg / redis / mysql2 and only
 *                 ever loads in the driver-host utilityProcess;
 *   the manifest  `@peek/driver-x/manifest`, this shape — pure data and pure
 *                 functions, no database client, importable from the renderer
 *                 and from main without dragging a client into either chunk.
 *
 * The split exists because the *description* of a database is needed in three
 * places at once (a connect form in the window, a display name in the sidebar, a
 * capability prediction before anything has connected) while the driver itself
 * is needed in exactly one. Before this, those descriptions lived wherever they
 * were consumed — a form table in the renderer, a capability table in core, an
 * endpoint switch in the MCP layer — so adding a database meant editing every
 * consumer, and forgetting one degraded silently.
 *
 * ## What is deliberately **not** here
 *
 * Anything the driver alone can answer (how to scan, how to introspect, how to
 * peek a value) stays behind `Driver` / `DriverSession`; a manifest is consulted
 * *before* a connection exists, so it cannot depend on one.
 *
 * Translations are not here either. `ConnectField.labelKey` names a key in the
 * renderer's shared message catalog rather than carrying text: field labels are
 * common vocabulary (host, port, password) and a per-package copy of the i18n
 * runtime for the two driver-flavoured keys would cost more than it saves. See
 * `K` below for how that reference stays checked.
 * ================================================================== */

/**
 * The message-key type, threaded through so the renderer can check it.
 *
 * Core has no message catalog and cannot name one, so the default is `string`.
 * The renderer re-declares the collected manifests as
 * `DriverManifest<PlainMessageKey>[]`, and *that* assignment is where every
 * `labelKey` is checked against the real catalog. It only works if the literal
 * types survived the trip out of the package — see `defineManifest`, which is
 * the only supported way to declare one, and the comment there for the two
 * spellings that silently destroy the check.
 *
 * `C` is the config branch this driver accepts. The dispatchers look a manifest
 * up *by* `config.driverId`, so a manifest never sees a config from another
 * driver; `endpointSummary` is declared with method syntax (hence bivariant
 * parameters) so each package can name its own branch instead of re-narrowing
 * the union by hand.
 */
export interface DriverManifest<
  K extends string = string,
  C extends ConnectionConfig = ConnectionConfig,
> {
  driverId: DriverId
  /** Proper name, as the vendor spells it: 'PostgreSQL', not 'postgres' */
  displayName: string
  /**
   * The **package's** version, not the database server's.
   *
   * What it answers is "which build of this connector am I running", which is
   * the first question anyone has when a driver behaves differently from the
   * last time. Settings shows it (`PluginsSection`), and in Phase C — where a
   * package can come from outside the repo and be updated on its own — it is the
   * only way to tell two installs apart at all.
   *
   * **Declared literally, and checked against `package.json` by
   * `manifest-versions.test.ts`.** Reading the real file at runtime is not
   * available to a module that has to load in the renderer chunk, and inferring
   * it from the app's version would make every package claim a number that is
   * not its own the moment one of them is published separately. A literal that a
   * test pins to the file is the same trade `DRIVER_REGISTRY` makes for
   * `capabilities`: stated twice, but never able to disagree.
   */
  version: string
  /**
   * What this driver can do, **declared by the package that implements it**.
   *
   * This is the prediction the UI and the MCP tools adapt to before a connection
   * exists. Once connected, `DriverSession.capabilities` is authoritative and
   * may be narrower (an older server, a driver that degraded).
   *
   * The package's own `Driver` and `DriverSession` read this same array, so the
   * advertised set and the implemented set cannot drift apart.
   */
  capabilities: readonly Capability[]
  /** The connect dialog's shape for this driver */
  connectForm: ConnectFormSpec<K>
  /** Form values → a `ConnectionConfig` draft (validated by the caller) */
  assembleConfig(mode: ConnectMode, values: ConnectFormValues, label: string): Record<string, unknown>
  /**
   * Which SQL grammar the query editor should highlight with. Absent means the
   * driver has no SQL surface at all (redis, qdrant) — not that it wants the
   * standard dialect.
   *
   * An identifier, not a CodeMirror object: the editor is a renderer dependency
   * and importing it here would put a syntax highlighter in the driver host.
   */
  sqlDialect?: SqlDialectId
  /** One line of address, for an MCP reader. The config has already been redacted. */
  endpointSummary(config: C): string
  /**
   * A minimal `connect` argument, shown verbatim in the MCP instructions.
   * Must contain no credentials — it is read by every connected client.
   */
  mcpConnectExample: string
  /**
   * The package's Agent Skill: what a model must know about driving **peek**
   * against this database, in prose, folded into `MCP_INSTRUCTIONS`.
   *
   * Not the SDK's `skills` option. That one is a directory of files read through
   * a `Skill` tool, and peek's embedded agent runs with `tools: []`, which may or
   * may not turn the `Skill` tool off with it — undecidable from the docs, so it
   * needs a live probe and that is Phase C's job. Widening the instructions
   * string has none of that uncertainty and no new plumbing: `mcpConnectExample`
   * already travels this exact path.
   *
   * Three rules, each with a test in `driver-skills.test.ts`:
   *
   * - **English**, always. Model-facing text, same bucket as `describeView` and
   *   `ResultMeta.summary` (`docs/PLAN.md`).
   * - **No credentials**, same as `mcpConnectExample` and checked by the same
   *   assertion — every connected client reads it.
   * - **Under `MAX_SKILL_CHARS`.** This is the rule that shapes what gets
   *   written. `MCP_INSTRUCTIONS` is fixed at `initialize` and read by every
   *   model on every session, so an unbounded paragraph here is a tax a user who
   *   only opens PostgreSQL pays for five databases they never touch. What
   *   survives a budget that tight is only ever the thing a model gets *wrong*
   *   without it — not a tour of the database.
   *
   * Absent is a fine answer, and means "nothing here would surprise a model that
   * read the general instructions".
   *
   * Known cost, recorded rather than solved: a package that is installed but
   * never connected still contributes its skill, because the text is built
   * before any connection exists. Phase B accepts that — the set of packages is
   * compiled in — and Phase C has to revisit it once packages can be installed
   * at runtime.
   */
  skill?: string
}

/**
 * The ceiling on one package's `skill`, in characters.
 *
 * ~1200 is four or five sentences: enough for the handful of facts that change
 * what a model *does*, not enough for background. The number is a judgement
 * call, but having one at all is not — see `DriverManifest.skill`.
 */
export const MAX_SKILL_CHARS = 1200

export type SqlDialectId = 'postgres' | 'mysql' | 'sqlite' | 'standard'

/**
 * Declare a manifest. **The only supported way** — the two obvious alternatives
 * both compile and both destroy the `labelKey` check silently.
 *
 * The check that matters happens in the renderer, where the collected manifests
 * are re-declared as `DriverManifest<PlainMessageKey>[]` and every `labelKey` is
 * measured against the real message catalog. That check has nothing to bite on
 * unless the literal types survive out of the package, and:
 *
 *   `const m: DriverManifest = {…}`      annotation ⇒ `labelKey: string`. Widened.
 *   `const m = {…} satisfies DriverManifest`
 *                                        also widened — measured, not assumed.
 *                                        `satisfies` supplies a contextual type,
 *                                        and a string literal contextually typed
 *                                        by `string` widens. (Sibling fields like
 *                                        `type: 'text'` *do* stay literal, because
 *                                        their contextual type is a literal union.
 *                                        That asymmetry is exactly why the bug
 *                                        would look fine on inspection.)
 *
 * The `const` type parameter is what preserves them. It also type-checks the
 * whole object at the declaration site, so a package still finds its own
 * mistakes without waiting for the app to collect it.
 *
 * A bad key surfaces as a compile error in
 * `apps/desktop/src/renderer/components/connectForm.ts`, naming the key.
 */
export function defineManifest<const K extends string, C extends ConnectionConfig>(
  manifest: DriverManifest<K, C>,
): DriverManifest<K, C> {
  return manifest
}

/* ------------------------------------------------------------------ */
/* The connect form                                                    */
/* ------------------------------------------------------------------ */

/**
 * How the user is spelling the connection.
 *
 * `url` and `fields` are two ways of saying one thing, not two kinds of
 * connection: the config union accepts either, and a driver that is handed both
 * lets the URL win. Offering them side by side in one form would therefore be a
 * trap — you would fill in a host, not notice the URL above it, and connect
 * somewhere else. A mode picker makes the choice explicit and exclusive.
 */
export type ConnectMode = 'url' | 'fields'

export type ConnectFieldType = 'text' | 'password' | 'number' | 'checkbox'

export interface ConnectField<K extends string = string> {
  /** Key into the form's value record, and the config property it fills */
  name: string
  type: ConnectFieldType
  /** A key in the renderer's message catalog; see `K` on DriverManifest */
  labelKey: K
  /**
   * Sample syntax. Never translated: a placeholder that reads as prose in one
   * language and as a URL in another is harder to copy from, not easier.
   */
  placeholder?: string
  /** Pre-filled so that the common case is "press Connect" */
  defaultValue?: string | boolean
  /** Connect stays disabled until this has a value */
  required?: boolean
  /** Render in the monospace face (URLs, paths, hosts) */
  mono?: boolean
}

export interface ConnectFormSpec<K extends string = string> {
  /** Available modes, the first being the default. A single-mode driver draws no picker. */
  modes: readonly ConnectMode[]
  fields: Readonly<Record<ConnectMode, readonly ConnectField<K>[]>>
}

export type ConnectFormValues = Readonly<Record<string, string | boolean>>

/* ------------------------------------------------------------------ */
/* Helpers a manifest's assembleConfig needs                           */
/* ------------------------------------------------------------------ */

/**
 * Read one text field, trimmed.
 *
 * Lives here rather than in each package because five copies of "trim it, and
 * treat a non-string as absent" is five chances to disagree about what an empty
 * box means — and the disagreement would show up as a connection that silently
 * went somewhere else.
 */
export function readFormText(values: ConnectFormValues, name: string): string {
  const raw = values[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

/** `{ key: value }` when the value exists, `{}` when it does not */
export function definedField<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

/**
 * The readers an `assembleConfig` works with, bound to one mode's field list.
 *
 * Only the active mode's fields are readable. A host typed before switching to
 * URL mode is still in the value record, and sending it as an override would
 * silently connect somewhere other than the URL on screen — so the reader
 * answers `undefined` for any field the current mode does not draw.
 */
export interface FormReaders {
  /** Trimmed text, or undefined when the field is absent from this mode or empty */
  text(name: string): string | undefined
  /** A number, or `NaN` when the text is not one — NaN survives to fail the schema loudly */
  num(name: string): number | undefined
  /** True only when ticked; undefined otherwise, so an unticked box stays off the config */
  bool(name: string): boolean | undefined
  /** Whether this mode draws the field at all */
  has(name: string): boolean
}

export function formReaders(
  fields: readonly ConnectField<string>[],
  values: ConnectFormValues,
): FormReaders {
  const names = new Set(fields.map((f) => f.name))
  const text = (name: string): string | undefined => {
    if (!names.has(name)) return undefined
    const raw = readFormText(values, name)
    return raw === '' ? undefined : raw
  }
  return {
    has: (name) => names.has(name),
    text,
    num: (name) => {
      const raw = text(name)
      if (raw === undefined) return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? n : Number.NaN
    },
    bool: (name) => (names.has(name) && values[name] === true ? true : undefined),
  }
}

/**
 * The `url` field, which four of the five drivers spell identically.
 *
 * Exported so a package declares its placeholder and nothing else; the label key
 * and the mono/required flags are the same wherever a connection string is
 * accepted, and a driver that disagreed about them would look like a different
 * dialog for no reason.
 */
export function urlField(placeholder: string): ConnectField<'connect.field.url'> {
  return {
    name: 'url',
    type: 'text',
    labelKey: 'connect.field.url',
    placeholder,
    required: true,
    mono: true,
  }
}

/* ------------------------------------------------------------------ */
/* Registry-shaped helpers (the app supplies the manifests)            */
/* ------------------------------------------------------------------ */

/**
 * A lookup over whatever manifests an app has wired up.
 *
 * Core declares the shape but holds no registry: a driver package depends on
 * core, so core importing driver packages would close the dependency graph into
 * a cycle. The app owns the list (`apps/desktop/src/drivers/manifests.ts`) and
 * every consumer goes through it.
 */
export type ManifestLookup = (driverId: DriverId) => DriverManifest | undefined
