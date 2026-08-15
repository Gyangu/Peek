import { z } from 'zod'
import { ConnectionConfigSchema } from './capability'
import type { Capability, ConnectionConfig, DriverId, RedactRules } from './capability'
import { zodIssueLines } from './errors'

/* ==================================================================
 * DriverManifest — what a database *is*, as opposed to what it does.
 *
 * A driver package has two halves that belong in different processes:
 *
 *   the driver    `@peek/db-x`, which imports pg / redis / mysql2 and only
 *                 ever loads in the driver-host utilityProcess;
 *   the manifest  `@peek/db-x/manifest`, this shape — pure data and pure
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
 * ## Data here, code next door
 *
 * This interface is **data only**, and that is a load-bearing property rather
 * than a style: a package is on its way to being a `peek-package.json` read off
 * disk (`docs/design/2026-08-07-database-packages-from-disk.md`), and JSON
 * cannot hold a function. What genuinely has to be code — how a connection is
 * *named* on screen — moved next door to `DriverDisplay`, which runs in the
 * package host and never has to be serialized. Read the two together; the split
 * between them, and why it falls exactly here, is `DriverDisplay`'s header.
 *
 * ## What is deliberately **not** here
 *
 * Anything the driver alone can answer (how to scan, how to introspect, how to
 * peek a value) stays behind `Driver` / `DriverSession`; a manifest is consulted
 * *before* a connection exists, so it cannot depend on one.
 *
 * ## Translations travel with the package (decision 3)
 *
 * `ConnectField.label` carries text, in the languages the package carries it in.
 * It used to be a `labelKey` naming an entry in the *renderer's* catalog, which
 * worked for exactly as long as every package shipped inside this repository: a
 * third-party field (`keyspace`, `bucket`, `clusterUrl`) has no entry there and
 * never will. Design 2026-08-07 §2.3(c) prices the change — "Host" is now
 * spelled once per package instead of once — and takes it, because the
 * alternative is a package that cannot label its own boxes.
 *
 * There is no type parameter left. It carried the message-key type so the
 * renderer could measure every `labelKey` against the real catalog; there is no
 * key to measure, and the check that replaces it is `parsePackageManifest`
 * refusing a field with no `en` text at load time.
 * ================================================================== */

/**
 * A user-facing string, with its translations.
 *
 * **`en` is required and everything else is optional**, which is peek's existing
 * rule for text rather than a new one: `describe`, `skill` and
 * `ResultMeta.summary` are English because a model reads them, and this adds a
 * human layer on the same floor. A locale peek has no entry for falls back to
 * `en` (see `localizedText`), so a package translated into nothing works
 * everywhere in English and a package translated into Japanese does not have to
 * know which locales peek ships.
 *
 * Literals, not message templates. `PlainMessageKey` narrowed the renderer's
 * catalog to keys taking no interpolation parameters, precisely so
 * `t(field.labelKey)` was safe to call with one argument. There is no call any
 * more, only a lookup, so the parameter problem does not arrive with it.
 */
export const LocalizedTextSchema = z.object({ en: z.string().min(1) }).catchall(z.string())
export type LocalizedText = z.infer<typeof LocalizedTextSchema>

/**
 * The text for a locale, or the English it falls back to.
 *
 * An empty translation counts as absent. A catalog entry someone left blank is
 * the one case where falling back reads as a bug and not translating reads as a
 * missing label, and a blank label names nothing at all.
 */
export function localizedText(text: LocalizedText, locale: string): string {
  const translated = text[locale]
  return typeof translated === 'string' && translated !== '' ? translated : text.en
}

export interface DriverManifest {
  driverId: DriverId
  /** Proper name, as the vendor spells it: 'PostgreSQL', not 'postgres' */
  displayName: string
  /**
   * The **package's** version, not the database server's.
   *
   * What it answers is "which build of this connector am I running", which is
   * the first question anyone has when a driver behaves differently from the
   * last time. Settings shows it (`PackagesSection`), and in Phase C — where a
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
  /**
   * The connect dialog's shape for this driver — and, since the config union
   * opened up, the **only** description of this driver's config there is.
   *
   * Two things read it and neither has a second source to fall back on: a field's
   * `name` is the config key it fills (`assembleFromForm`, after `assembleConfig`
   * went away), and a field's `type` is what that key is parsed as
   * (`connectionFieldsOf`, after the six `z.object` branches stopped being the
   * schema). Both are the same claim — a form that asks for something the config
   * has no room for is a form nobody can submit — which is why they are one
   * declaration rather than two that have to agree.
   */
  connectForm: ConnectFormSpec
  /**
   * Which SQL grammar the query editor should highlight with. Absent means the
   * driver has no SQL surface at all (redis, qdrant) — not that it wants the
   * standard dialect.
   *
   * An identifier, not a CodeMirror object: the editor is a renderer dependency
   * and importing it here would put a syntax highlighter in the driver host.
   */
  sqlDialect?: SqlDialectId
  /**
   * Which fields carry secrets, and how each one is scrubbed before the config
   * is shown to anyone. Applied by `redactConnectionConfig`, which is the single
   * chokepoint every outbound copy of a config passes through.
   *
   * **Declared, not computed, and the kernel is what applies it.** Redaction is
   * the other half of the rule `identity` follows: whatever decides *who is who*
   * or *what gets erased* is the kernel's to do, because getting it wrong is a
   * security incident rather than something that merely looks bad. A package
   * naming its own secret fields is a fact about its config shape; a package
   * running its own redaction would be a package that can decline to.
   *
   * An empty block is legal and means the config travels verbatim — see
   * `redactConnectionConfig` for what that costs.
   */
  redact: RedactRules
  /**
   * The config fields that, together with `driverId`, say which connection this
   * is. Order matters: it is part of the string `connectionIdentity` builds, so
   * reordering the list re-keys every saved credential.
   *
   * A list of names and nothing more — the joining, the `driverId` prefix and the
   * URL password-stripping are all `connectionIdentity`'s, for the reason spelled
   * out there.
   */
  identity: readonly string[]
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

/* ------------------------------------------------------------------ */
/* The other half: the three strings that name a connection            */
/* ------------------------------------------------------------------ */

/**
 * How a connection is *called*, computed by the package that owns the database.
 *
 * Three strings, one config, no database client — but code, not data, and the
 * manifest's counterpart rather than part of it:
 *
 *   label     the short name for a 240px sidebar row that truncates at the end,
 *             so it carries the part that tells two connections apart;
 *   detail    the long form the label had to drop, for the row's tooltip;
 *   endpoint  one line of address for an MCP reader.
 *
 * ## Why these three are code when everything above them is data
 *
 * They were going to be data. The plan was a small interpolation language —
 * `"{host:localhost}:{port:5432}/{database}"` — and translating the six built-in
 * databases into it is what killed it: each one needed a syntax the last had
 * not. Defaults, then a fallback chain (`host`, or the host parsed out of the
 * URL), then derived values, then omit-when-equal-to-the-default, then
 * omit-this-whole-fragment-if-empty — five, and `detail` still did not fit,
 * because `hostPort` drops the *port along with* a missing host and that needs
 * grouping. Six syntaxes for six databases is not a format, it is a programming
 * language with no debugger.
 *
 * The premise was the mistake. It said these had to be data because the renderer
 * calls them and the renderer may never execute a package's JS. The first half is
 * true; the second does not follow. **The window needs the three strings, not the
 * code that produces them** — and a connection's config never changes once it is
 * open, so the strings are computed exactly once, when the connection opens, and
 * stored alongside it. A connect is already a few hundred milliseconds of
 * asynchronous work; one more process hop into the package host is free, and
 * nothing recomputes afterwards.
 *
 * Which buys back unlimited expressiveness at no cost, and that is the point: the
 * six built-ins keep their behaviour **verbatim**, so migrating them is checked
 * by comparing output rather than by arguing about whether a template could have
 * said it.
 *
 * ## Why `identity` and `redact` did not come along
 *
 * They look like the same kind of thing and they are not. These three decide how
 * a connection *looks*; `identity` decides which connection *is which*, and
 * `redact` decides what gets erased. Getting one of those wrong releases a stored
 * password to the wrong connection or leaks it outright, so both stay declarative
 * and the kernel computes them. Getting a label wrong is ugly. That is the whole
 * dividing line, and it is worth stating plainly because it will keep coming up:
 * **who-is-who and what-gets-erased belong to the kernel; what-it-looks-like
 * belongs to the package.**
 *
 * `C` is the config branch this driver accepts. The dispatchers look an
 * implementation up *by* `config.driverId`, so it never sees a config from
 * another driver; the three are declared with method syntax (hence bivariant
 * parameters) so each package can name its own branch instead of re-narrowing the
 * union by hand.
 *
 * ## All three answer; none of them throws
 *
 * `C` says every field is where it should be, and a config that was cast, or came
 * off disk from a future version of peek, can still arrive with one missing. An
 * implementation names it something — the driver id is the usual last resort —
 * rather than letting a `.replace` on `undefined` out. The kernel does throw, but
 * for the other failure: no display **at all** for a driver id — the `display`
 * case of `PackageHostRuntime` in `package-host.ts`, which is a package that is
 * not loaded and a sentence a developer can act on. A `TypeError` from inside
 * one of these six is not, and one package failing that way while five degrade
 * is a difference nobody chose.
 *
 * There is no `defineDisplay`, and since decision 3 there is no `defineManifest`
 * either: both existed to keep a `labelKey`'s literal type from widening on its
 * way out of a package, and a package now carries the text itself.
 */
export interface DriverDisplay<C extends ConnectionConfig = ConnectionConfig> {
  /** Short name for the sidebar row. The config has already been redacted. */
  label(config: C): string
  /** The long form, for the tooltip; never merely a repeat of `label`. */
  detail(config: C): string
  /** One line of address, for an MCP reader. The config has already been redacted. */
  endpoint(config: C): string
}

/**
 * The ceiling on one package's `skill`, in characters.
 *
 * ~1200 is four or five sentences: enough for the handful of facts that change
 * what a model *does*, not enough for background. The number is a judgement
 * call, but having one at all is not — see `DriverManifest.skill`.
 */
export const MAX_SKILL_CHARS = 1200

export const SQL_DIALECT_IDS = ['postgres', 'mysql', 'sqlite', 'standard'] as const
export const SqlDialectIdSchema = z.enum(SQL_DIALECT_IDS)
export type SqlDialectId = z.infer<typeof SqlDialectIdSchema>

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
export const CONNECT_MODES = ['url', 'fields'] as const
export const ConnectModeSchema = z.enum(CONNECT_MODES)
export type ConnectMode = z.infer<typeof ConnectModeSchema>

/**
 * The four kinds of box a connect form can draw — and, since the config union
 * opened up, the four kinds of value a config key can hold. Declared as a schema
 * because a package manifest read off disk names one of these as a string, and a
 * second list to validate that against is a second list to keep in step.
 */
export const CONNECT_FIELD_TYPES = ['text', 'password', 'number', 'checkbox'] as const
export const ConnectFieldTypeSchema = z.enum(CONNECT_FIELD_TYPES)
export type ConnectFieldType = z.infer<typeof ConnectFieldTypeSchema>

export interface ConnectField {
  /** Key into the form's value record, and the config property it fills */
  name: string
  type: ConnectFieldType
  /**
   * What the box is called, in the languages this package speaks.
   *
   * Carried rather than referenced: see the header. `en` is the floor, every
   * other locale falls back to it, and `localizedText` is the whole runtime.
   */
  label: LocalizedText
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
  /**
   * Write this key into the config even when the box is empty or unticked.
   *
   * The default is the opposite — an empty field is an absent key — because for
   * an optional field the two are the same statement and an empty string sent as
   * an override is worse than nothing. Three fields across the six built-ins
   * genuinely need the other answer, and each for its own reason:
   *
   *   qdrant `url`, sqlite `file`  required and unconditional, so that an empty
   *                                box reaches the schema and is refused *by
   *                                name* rather than vanishing into an omitted
   *                                key and being refused as "required";
   *   sqlite `readOnly`            a ticked-by-default box where "I unticked it"
   *                                has to survive the trip; an omitted `false`
   *                                would silently be re-defaulted to true.
   *
   * For a checkbox, `always` also means the field's `defaultValue` stands in when
   * the form has no value at all — the box's declared position is the answer,
   * which is not the same as `false`.
   */
  always?: boolean
  /**
   * Bounds on a `number`, for the schema rather than for the form.
   *
   * The only two things in a field declaration the dialog has no use for, and
   * they are here rather than in a config schema of their own because the field
   * list **is** the config schema (`connectionConfigSchema`): a port is `min: 1,
   * max: 65535`, and saying so twice — once for the box, once for the parse — is
   * the mirror-table mistake `validateConnectionConfig`'s header already records.
   *
   * Ignored for every other type. The six in-repo packages do not declare them
   * yet; they will when they move to `~/.peek/packages/`, and until then a port
   * is checked for being a number and not for being a port.
   */
  min?: number
  max?: number
}

export interface ConnectFormSpec {
  /** Available modes, the first being the default. A single-mode driver draws no picker. */
  modes: readonly ConnectMode[]
  fields: Readonly<Record<ConnectMode, readonly ConnectField[]>>
}

export type ConnectFormValues = Readonly<Record<string, string | boolean>>

/* ------------------------------------------------------------------ */
/* The connect form *is* the config schema                             */
/* ------------------------------------------------------------------ */

/**
 * One field of a config, as the parse sees it.
 *
 * Deliberately **not** `ConnectField` with a narrower reading of `required`.
 * They differ on the one question that matters here and agreeing on a property
 * name would hide it: a form's `required` is per mode — postgres wants a `host`
 * in fields mode and a `url` in URL mode, and a config carrying either is a
 * complete config. `mandatory` is the resolved answer, and the distinct word is
 * what stops a raw `connectFields(driverId, mode)` list from being passed in and
 * quietly making every field of one mode compulsory.
 */
export interface ConnectionField {
  name: string
  type: ConnectFieldType
  /** Whether a config with no such key is refused; see `connectionFieldsOf` */
  mandatory: boolean
  /** Numeric bounds, when the package declared them */
  min?: number
  max?: number
}

/**
 * The fields a driver's config may carry, resolved over the modes its form
 * offers.
 *
 * **This is the config schema, and it is not written down twice.** Before this,
 * a database's fields were a `z.object` branch in core and a field list in the
 * package, which is the mirror-table mistake with a security edge — a package
 * loaded off disk brings its own fields, and core cannot have a branch for it.
 * The form already names every field and its type, so the form is what the parse
 * reads (design 2026-08-07 §2.6).
 *
 * **Mandatory means required in every mode.** A field only some modes draw
 * cannot be compulsory: the config the other mode produces would be refused for
 * a box the user was never shown. Across the six in-repo packages that resolves
 * to exactly two fields — sqlite's `file` and qdrant's `url`, both in
 * single-mode forms — which is precisely the pair the hand-written branches
 * declared non-optional. The two also carry `ConnectField.always`, and they have
 * to: without it an empty box is an *omitted* key, and the refusal says
 * "required" instead of naming the box the user left blank.
 */
export function connectionFieldsOf(form: ConnectFormSpec): readonly ConnectionField[] {
  const fields = new Map<string, ConnectionField>()
  for (const mode of form.modes) {
    for (const field of form.fields[mode]) {
      if (fields.has(field.name)) continue
      fields.set(field.name, {
        name: field.name,
        type: field.type,
        mandatory: form.modes.every((m) =>
          form.fields[m].some((f) => f.name === field.name && f.required === true),
        ),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
      })
    }
  }
  return [...fields.values()]
}

/**
 * What one field accepts.
 *
 * A mandatory string is `.min(1)` rather than plain: the two fields that reach
 * this branch are written even when their box is empty (`ConnectField.always`),
 * so an empty string is what an unfilled required field actually looks like, and
 * accepting it would send `file: ''` to a driver.
 */
function connectionFieldSchema(field: ConnectionField): z.ZodType<unknown> {
  switch (field.type) {
    case 'checkbox':
      return field.mandatory ? z.boolean() : z.boolean().optional()
    case 'number': {
      let schema = z.number()
      if (field.min !== undefined) schema = schema.min(field.min)
      if (field.max !== undefined) schema = schema.max(field.max)
      return field.mandatory ? schema : schema.optional()
    }
    case 'text':
    case 'password':
      return field.mandatory ? z.string().min(1) : z.string().optional()
  }
}

/**
 * What to do with a key the package never declared.
 *
 *   'drop'  the connect dialog's answer. A value left over from the other mode
 *           must not survive into the config, and this is the last place it
 *           could be removed.
 *   'keep'  everything main reads back. A config on disk can carry keys no form
 *           draws — `connectTimeoutMs`, postgres's `searchPath` — written by an
 *           MCP caller who knows the database, and dropping them on a re-read
 *           would silently rewrite the user's connection.
 */
export type UnknownConfigKeys = 'drop' | 'keep'

export type ConnectionConfigOutcome =
  { ok: true; config: ConnectionConfig } | { ok: false; issues: readonly string[] }

/**
 * Parse a value into a config for **this** driver, or say what is wrong with it.
 *
 * Two halves, because they know different amounts. `ConnectionConfigSchema` is
 * everything core can check without a manifest — it is a record, its `driverId`
 * is a servable id — and it is what a `conn.open` argument is validated by
 * before any registry has been consulted. This adds the half that needs the
 * package: each declared field measured against the type the form draws it with.
 *
 * Field by field rather than through one composed `z.object`, because the issue
 * a caller reports has to *name the box*: `port: expected number` is what lets
 * the connect dialog put the message next to the input the user typed into, and
 * a composed parse of an open record cannot be given that shape without
 * fighting the inferred types.
 *
 * A field the config does not carry is simply absent from the result — the
 * presence of a key is information downstream reads (a `url` set means the URL
 * wins over host/port), so nothing is filled in on a package's behalf.
 */
export function parseConnectionConfig(
  value: unknown,
  form: ConnectFormSpec,
  unknownKeys: UnknownConfigKeys,
): ConnectionConfigOutcome {
  const base = ConnectionConfigSchema.safeParse(value)
  if (!base.success) return { ok: false, issues: zodIssueLines(base.error) }

  const declared = new Set<string>(['driverId', 'label'])
  const draft: Record<string, unknown> = {}
  const issues: string[] = []

  for (const field of connectionFieldsOf(form)) {
    declared.add(field.name)
    const parsed = connectionFieldSchema(field).safeParse(base.data[field.name])
    if (!parsed.success) {
      // The value handed to the parse *is* the field, so its issues have no path
      // of their own — the name is prefixed here, which is what lets the connect
      // dialog put the message beside the box the user typed into.
      issues.push(...parsed.error.issues.map((issue) => `${field.name}: ${issue.message}`))
      continue
    }
    if (parsed.data !== undefined) draft[field.name] = parsed.data
  }

  if (unknownKeys === 'keep') {
    for (const [key, item] of Object.entries(base.data)) {
      if (!declared.has(key)) draft[key] = item
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    config: {
      ...draft,
      driverId: base.data.driverId,
      ...(base.data.label === undefined ? {} : { label: base.data.label }),
    },
  }
}

/* ------------------------------------------------------------------ */
/* Form values → a connection config                                   */
/* ------------------------------------------------------------------ */

/**
 * Turn a filled-in connect form into a `ConnectionConfig` draft. The caller
 * validates it — this only assembles.
 *
 * **This used to be a method on every manifest** (`assembleConfig`), and reading
 * the five implementations side by side is what deleted it: they did the same
 * thing, spelled out field by field. postgres was eight lines of
 * `definedField('host', text('host'))`, and not one line of any of them renamed
 * a field, computed one, or moved a value anywhere but the config key of the
 * same name. So it was never configuration; it was a convention that each
 * package happened to re-type, with five chances to type it differently.
 *
 * The convention, stated once:
 *
 *   a field's `name` is the config key it fills; `text`/`password` give a
 *   trimmed string, `number` a number (`NaN` when it will not parse, so the
 *   schema fails loudly instead of the field vanishing), `checkbox` a `true`
 *   only when ticked; an empty box means the key is omitted entirely; and only
 *   the fields the **current mode draws** are read at all.
 *
 * That last clause is the one worth having in one place: a host typed before the
 * user switched to URL mode is still sitting in the value record, and sending it
 * as an override would connect somewhere other than the URL on screen. It is
 * `formReaders` that enforces it, which is why this reuses that rather than
 * re-reading `values`.
 *
 * The three fields the convention could not cover carry `ConnectField.always`;
 * see there for which and why.
 *
 * It lives in core rather than in the packages because it stopped being a
 * package's behaviour the moment it stopped varying between them: this is now
 * how peek reads *a* connect form, and a package that wanted a different answer
 * would be describing a form peek does not know how to draw.
 */
export function assembleFromForm(
  manifest: DriverManifest,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): Record<string, unknown> {
  const fields = manifest.connectForm.fields[mode]
  const { text, num, bool } = formReaders(fields, values)
  const config: Record<string, unknown> = { driverId: manifest.driverId }
  // An empty name is the user not having named it, which is not the same as
  // naming it '' — main derives a display name in that case.
  if (label) config['label'] = label

  for (const field of fields) {
    const always = field.always === true
    switch (field.type) {
      case 'checkbox': {
        const ticked = bool(field.name)
        if (ticked !== undefined) config[field.name] = ticked
        else if (always) {
          const raw = values[field.name]
          config[field.name] = typeof raw === 'boolean' ? raw : field.defaultValue === true
        }
        break
      }
      case 'number': {
        const n = num(field.name)
        if (n !== undefined) config[field.name] = n
        // NaN rather than 0: an empty required number is a mistake to report, and
        // 0 is a value some of these fields legitimately take (redis `db`).
        else if (always) config[field.name] = Number.NaN
        break
      }
      case 'text':
      case 'password': {
        const value = text(field.name)
        if (value !== undefined) config[field.name] = value
        else if (always) config[field.name] = readFormText(values, field.name)
        break
      }
    }
  }
  return config
}

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
 * The readers `assembleFromForm` works with, bound to one mode's field list.
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

export function formReaders(fields: readonly ConnectField[], values: ConnectFormValues): FormReaders {
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
 * Exported so a package declares its placeholder and nothing else; the label,
 * and the mono/required flags, are the same wherever a connection string is
 * accepted, and a driver that disagreed about them would look like a different
 * dialog for no reason.
 *
 * It is a **default, not a rule** — a package outside this repository writes its
 * own field, in its own words. What this saves is the five in-repo packages
 * spelling one identical box five times, which decision 3 made possible for the
 * first time and would otherwise have made mandatory.
 */
export function urlField(placeholder: string): ConnectField {
  return {
    name: 'url',
    type: 'text',
    label: { en: 'Connection string', 'zh-CN': '连接串' },
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
