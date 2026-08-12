import { z } from 'zod'
import { CapabilitySchema, PACKAGE_ID_PATTERN, RedactRuleSchema } from './capability'
import { zodIssueLines } from './errors'
import {
  ConnectFieldTypeSchema,
  ConnectModeSchema,
  LocalizedTextSchema,
  MAX_SKILL_CHARS,
  SqlDialectIdSchema,
  type ConnectMode,
  type DriverManifest,
} from './manifest'

/* ==================================================================
 * `peek-package.json` — what a database package says about itself.
 *
 * The serialized form of declarations that already exist. Every key below is a
 * field of `DriverManifest` (see `./manifest`) that survived the demotion to
 * pure data, arranged the one way a file has to be arranged and no other way:
 * one file per package, and a package may ship more than one database
 * (`db-sql` is mysql *and* sqlite), so `drivers` is a list.
 *
 * ## Why nothing here is new vocabulary
 *
 * A manifest read off disk is the only description of a database peek will have.
 * The temptation is to give it a richer language than the in-repo declaration
 * had — a config schema of its own, a template dialect for display strings — and
 * the design records both of those being tried and refused (§2.3(b), §3.2). What
 * is left is exactly the data half of `DriverManifest`, plus the two things a
 * file needs that a module did not: where the code is (`entry`), and which
 * kernel it was written against (`peek`).
 *
 * `viewKinds` and `tools` are the same move applied to the other two things a
 * package contributes: each is split down the middle by §2.4bis(d), and the half
 * that is data is here. Nothing in either is new either — they are the fields of
 * `ViewKindRegistration` and `ToolMeta` that a `JSON.parse` can produce.
 *
 * ## Failure is loud, and says which key
 *
 * `parsePackageManifest` answers with a list of `path: message` lines rather
 * than throwing, because the loader reports them to a user who is looking at a
 * directory that did not install. "Refused" with nothing after it is the failure
 * mode the design named twice (§2.3, §4.2): a package that half-loads, or one
 * that is rejected for a reason nobody can act on, are the two things this file
 * exists to prevent.
 *
 * ## What is deliberately *not* checked here
 *
 * - **Whether the entry files exist.** This module is a pure function of a
 *   parsed JSON value so a test can drive it without a filesystem; the loader
 *   stats the paths it is handed.
 * - **The `peek` range against this build.** Version *compatibility* is a policy
 *   decision the loader makes (§2.5 compares the first three semver segments and
 *   nothing else); the schema's job is that the field is there and is a string.
 * - **Signatures, hashes, or anything else that would look like vetting.**
 *   Decision 6: peek does not validate packages. Everything above is a check
 *   that peek can *use* the package, never that it should be trusted.
 * ================================================================== */

/** The file a package directory is recognised by. */
export const PACKAGE_MANIFEST_FILE = 'peek-package.json'

/* ------------------------------------------------------------------ */
/* The connect form, as a file spells it                               */
/* ------------------------------------------------------------------ */

/**
 * One box in the connect dialog — `ConnectField`, verbatim.
 *
 * There is nothing left to translate between the two. `label` used to be the
 * new spelling of a `labelKey` that named an entry in the *renderer's* catalog,
 * and both parsed while the in-repo packages still spelled it the old way; they
 * carry their own text now (decision 3), so the transitional key is gone and
 * `label` is simply required. A field without one has no name a user could read.
 *
 * `min` / `max` are here only in the sense of being written down. They are the
 * two modifiers the field list needs to be a config schema as well as a form
 * (`connectionFieldsOf`), and a port is the reason: the box does not care that
 * 65535 is the ceiling, and the parse must.
 */
const PackageConnectFieldSchema = z.object({
  name: z.string().min(1),
  type: ConnectFieldTypeSchema,
  label: LocalizedTextSchema,
  placeholder: z.string().optional(),
  defaultValue: z.union([z.string(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  mono: z.boolean().optional(),
  always: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

export type PackageConnectField = z.infer<typeof PackageConnectFieldSchema>

/**
 * The fields, per mode.
 *
 * Both modes are named even though most packages draw one, and both default to
 * empty, so a single-mode package writes one array instead of an empty one it
 * does not care about. `satisfies` is what ties the two keys to `ConnectMode`:
 * a third mode added to that union stops this from compiling, which is the
 * whole reason to spell them out rather than accept any string.
 */
const PackageConnectFieldsSchema = z.object({
  url: z.array(PackageConnectFieldSchema).default([]),
  fields: z.array(PackageConnectFieldSchema).default([]),
}) satisfies z.ZodType<Record<ConnectMode, readonly PackageConnectField[]>, unknown>

/**
 * How this database is addressed, as a form.
 *
 * Two checks beyond the shape, both of them about a package that would install
 * and then be unusable:
 *
 * - **an offered mode has to draw something.** A mode with no fields is a dialog
 *   with no boxes: nothing to type into, and `assembleFromForm` reads nothing,
 *   so the user is offered a database they cannot connect to.
 * - **no two fields of one mode share a name.** `name` is the key into the form's
 *   value record *and* the config property it fills, so a duplicate is two boxes
 *   writing one slot — the second one typed into wins and the config carries a
 *   value the user believes belongs to the other field.
 */
const PackageConnectFormSchema = z
  .object({
    /** Available modes, the first being the default */
    modes: z.array(ConnectModeSchema).min(1),
    fields: PackageConnectFieldsSchema,
  })
  .superRefine((form, ctx) => {
    for (const mode of form.modes) {
      const fields = form.fields[mode]
      if (fields.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', mode],
          message: `mode '${mode}' is offered but draws no field`,
        })
      }
      const names = fields.map((f) => f.name)
      const duplicate = names.find((name, at) => names.indexOf(name) !== at)
      if (duplicate !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', mode],
          message: `two fields of mode '${mode}' are both named '${duplicate}'`,
        })
      }
    }
  })

/* ------------------------------------------------------------------ */
/* One driver                                                          */
/* ------------------------------------------------------------------ */

/**
 * One database, described without connecting to it — `DriverManifest`'s data
 * fields, and nothing else.
 *
 * `version` is the one field that does not appear, and its absence is the point:
 * it was always documented as *the package's* version rather than the database
 * server's, so a file that states it once per package cannot have two drivers of
 * one package disagreeing about which build they came from. The loader hands it
 * down.
 *
 * `redact` has **no default**, and that is deliberate. Absent and `{}` mean the
 * same thing to `redactConnectionConfig` — the config travels verbatim — but not
 * to the loader: an omitted block is a package that never thought about it and
 * earns the warning decision 5 requires, while an explicit `{}` is sqlite saying
 * it holds no secret. Defaulting one into the other would delete the only signal
 * that tells them apart.
 */
const PackageDriverSchema = z
  .object({
    driverId: z.string().regex(PACKAGE_ID_PATTERN, 'must be lowercase letters, digits and hyphens'),
    /** Proper name, as the vendor spells it: 'PostgreSQL', not 'postgres' */
    displayName: z.string().min(1),
    capabilities: z.array(CapabilitySchema).min(1, 'a driver with no capability can open no view'),
    connectForm: PackageConnectFormSchema,
    sqlDialect: SqlDialectIdSchema.optional(),
    /** Field name → how to scrub it; see the note above on why there is no default */
    redact: z.record(z.string().min(1), RedactRuleSchema).optional(),
    /** The fields that, with `driverId`, say which connection this is. Order matters. */
    identity: z.array(z.string().min(1)).min(1, 'a driver with no identity fields collapses every connection into one'),
    mcpConnectExample: z.string().min(1),
    skill: z.string().max(MAX_SKILL_CHARS).optional(),
  })
  .superRefine((driver, ctx) => {
    // Both of these were an exhaustive `switch` over the config union until the
    // union opened up, so `config.passwrd` was a compile error and neither
    // mistake could be written down. Now they are strings, they name fields
    // nothing declares, and **neither one fails loudly on its own**:
    // `redactConnectionConfig` skips a rule the config has no field for, so the
    // secret it was meant to scrub travels in the clear; `connectionIdentity`
    // reads a missing field as an empty slot, so two connections differing only
    // there collapse onto one keychain entry and one account's password is
    // released to the other. `manifest-declarations.test.ts` is the in-repo half
    // of this check; this is the half that covers a package peek did not build.
    const declared = new Set<string>()
    for (const mode of CONNECT_MODE_LIST) {
      for (const field of driver.connectForm.fields[mode]) declared.add(field.name)
    }
    for (const name of Object.keys(driver.redact ?? {})) {
      if (declared.has(name)) continue
      ctx.addIssue({
        code: 'custom',
        path: ['redact', name],
        message: `redacts '${name}', which no field of this driver's form declares, so the rule matches nothing`,
      })
    }
    for (const name of driver.identity) {
      if (declared.has(name)) continue
      ctx.addIssue({
        code: 'custom',
        path: ['identity'],
        message: `identifies connections by '${name}', which no field of this driver's form declares, so it reads as empty on every connection`,
      })
    }
  })

export type PackageDriverManifest = z.infer<typeof PackageDriverSchema>

/** Both modes, whether or not a form offers them — a field parked under an unoffered mode still names a config key. */
const CONNECT_MODE_LIST: readonly ConnectMode[] = ConnectModeSchema.options

/* ------------------------------------------------------------------ */
/* What a package contributes besides a database                       */
/* ------------------------------------------------------------------ */

/**
 * A view kind, as much of one as can be known without running the package.
 *
 * §2.4bis(d) cuts a `ViewKindRegistration` in half. The four functions —
 * `autoFetch`, `describe`, `title`, `collectionRef` — are in `contrib.mjs` and
 * only ever run in that package's own host process; these three fields are data
 * and are here. The cut is what makes the lazy start possible: "which views can
 * this connection open" is asked every time a connection is selected, and
 * answering it from the manifest means twenty installed packages are still
 * twenty processes not started.
 *
 * `title` is the **kind's** name — "Graph" — and not the registration's
 * `title(view)`, which names one open view ("Graph :Person"). It is
 * `LocalizedText` rather than the registration's `titleKey` for exactly the
 * reason decision 3 turned `labelKey` into `label`: a key names an entry in the
 * *renderer's* catalog, which a package peek did not build has no way to add to,
 * so a third-party kind would paint its own message key into the tab strip.
 */
const PackageViewKindSchema = z.object({
  /** `'graph'`, `'documents'` — `PackageViewState.packageKind`, and the key both registries agree on. */
  kind: z.string().min(1),
  /** The drivers this kind is offered on; checked against the ones this package ships. */
  driverIds: z.array(z.string().min(1)).min(1, 'a view kind offered on no driver can be opened from nowhere'),
  title: LocalizedTextSchema,
})

export type PackageViewKind = z.infer<typeof PackageViewKindSchema>

/**
 * The name class a tool has to be in to survive the trip to a model.
 *
 * Not peek's rule and not enforced for peek's benefit: the name is published by
 * `tools/list` and travels on to whatever provider the client talks to, and the
 * function-name field on the way there is letters, digits, `_` and `-`, bounded.
 * A name outside it is refused **by the client**, which is the worst place for
 * it to fail — one bad package, and the whole tool list is what breaks.
 */
const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * `properties`, if the schema has one, as a record of subschemas.
 *
 * `true` and `false` are legal JSON Schemas ("anything" and "nothing"), so they
 * are accepted even though nothing peek builds emits one — refusing them would
 * be this file inventing a dialect narrower than the one it forwards.
 */
function propertiesAreSubschemas(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every(
    (sub) => typeof sub === 'boolean' || (typeof sub === 'object' && sub !== null && !Array.isArray(sub)),
  )
}

/**
 * The input schema, checked as far as "MCP can publish this" and no further.
 *
 * Deliberately not a JSON Schema validator. peek forwards this value verbatim —
 * to the MCP SDK, and from there to a model provider — so a full meta-schema
 * check here would be peek holding an opinion about a dialect it does not
 * interpret, and it would refuse packages for schemas that work.
 *
 * What is checked is the one thing that is not a matter of dialect: a tool is
 * called with a named-argument object, so its schema is an object schema. A
 * `type: "array"` or a bare `true` parses as JSON and then fails at the client,
 * one layer past anything that could name the package it came from.
 */
const ToolInputSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (schema) => schema['type'] === 'object',
    'must be a JSON Schema with "type": "object" — a tool is called with named arguments',
  )
  .refine(
    (schema) => propertiesAreSubschemas(schema['properties']),
    'its "properties" must map each argument name to a schema',
  )

/**
 * A JSON Schema turned into the validator peek runs a call through.
 *
 * The single entry point for that conversion, and it is exported because two
 * layers need the identical answer at two different times: `PackageToolSchema`
 * below asks "can this be converted at all" while the package is being
 * installed, and `mcp/package-tools.ts` asks for the schema itself when it
 * builds the stand-in main registers. Two spellings of the conversion would be
 * a package that installs and then cannot be called.
 *
 * ## Why converting at all, given this file promises not to interpret the schema
 *
 * §4duodecies(c) says peek holds no opinion about the JSON Schema dialect a
 * package writes — it forwards the value on to the MCP SDK and to a model
 * provider, and a meta-schema check here would refuse packages that work. That
 * still stands. What decision §4duodevicies added is not an opinion but a
 * *need*: executing a call means validating its arguments, peek validates with
 * zod, so a schema zod cannot represent is a tool that has no way to be called.
 * Refusing it while a person is installing the package names the package; the
 * alternative surfaces the first time a model tries to use it.
 *
 * Never throws. `z.fromJSONSchema` throws on a construct it cannot express, and
 * the caller here is a parser whose whole contract is a list of issues.
 */
export function packageToolInputSchema(
  json: Record<string, unknown>,
): { ok: true; schema: z.ZodType } | { ok: false; issue: string } {
  try {
    return { ok: true, schema: z.fromJSONSchema(json) }
  } catch (error) {
    return { ok: false, issue: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The fields shared by both kinds of tool declaration.
 *
 * `name` / `description` / `inputSchema` are the whole of MCP's `Tool` and were
 * the whole of this schema until §4duodevicies; `title` and `annotations` joined
 * them because a tool is *registered* with all five, and registration happens
 * before anything has been called. An `annotations` fetched at first call would
 * reach the model after it had already decided whether calling a tool marked
 * `destructiveHint` was a good idea.
 */
const PackageToolBase = {
  name: z.string().regex(MCP_TOOL_NAME_PATTERN, 'must be 1-64 letters, digits, underscores or hyphens'),
  /** What the model chooses by. An empty one is a tool that gets called by accident or not at all. */
  description: z.string().min(1),
  inputSchema: ToolInputSchemaSchema.superRefine((schema, ctx) => {
    const converted = packageToolInputSchema(schema)
    if (converted.ok) return
    ctx.addIssue({
      code: 'custom',
      message: `cannot be turned into the validator a call is checked against: ${converted.issue}`,
    })
  }),
  /** MCP `Tool.title` — what a client labels the tool with, where it shows one. */
  title: z.string().min(1).optional(),
  /** MCP's hints. Carried, never interpreted: peek reads none of them. */
  annotations: z
    .object({
      title: z.string().min(1).optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
}

/**
 * One MCP tool, without the mapping that runs it.
 *
 * The other half of §2.4bis(d)'s table, and the half `tools/list` is answered
 * from, while `toCommands` / `render` stay in `contrib.mjs`. Listing the tools
 * of twenty installed packages therefore starts no process, which is what
 * acceptance 31 counts.
 *
 * ## A discriminated union rather than one object with optional fields
 *
 * `hasRenderer` is a statement about a command tool and means nothing about a
 * read tool — `defineReadTool` has no receipt to override. Written as an
 * optional field on a flat object it would be silently ignored on the read
 * branch, which is exactly how the next person comes to believe it took effect.
 * Here a `kind: "read"` declaration that carries one is refused and says so.
 */
const PackageToolSchema = z.discriminatedUnion('kind', [
  z.object({
    /** `read` and `command` are two constructors in the executor, not a label. */
    kind: z.literal('read'),
    /**
     * Refused rather than ignored, and `z.never()` is the only spelling that
     * does that: `z.object` strips keys it does not know, so leaving this out
     * would accept `hasRenderer` on a read tool and silently drop it — which is
     * how the next person comes to believe it took effect.
     */
    hasRenderer: z
      .never('a read tool writes its own output, so there is no receipt for hasRenderer to be about')
      .optional(),
    ...PackageToolBase,
  }),
  z.object({
    kind: z.literal('command'),
    /**
     * Whether the package writes its own receipt.
     *
     * Required rather than defaulted, because `defineCommandTool` reads a
     * missing `render` as "use the default receipt" and there is no third
     * answer: a stand-in that guessed would either drop a receipt the package
     * wrote or ask for one it does not have. `toolFromMeta` in the host is what
     * stops the declaration disagreeing with the mapping.
     */
    hasRenderer: z.boolean(),
    ...PackageToolBase,
  }),
])

export type PackageToolDeclaration = z.infer<typeof PackageToolSchema>

/* ------------------------------------------------------------------ */
/* Where the code is                                                   */
/* ------------------------------------------------------------------ */

/**
 * A path inside the package directory, and provably inside it.
 *
 * Refused: absolute paths, Windows drive letters, backslashes, and any `..` or
 * `.` segment. This is the same containment argument `resolvePackageAsset` makes
 * about a URL, made one layer earlier and for the same reason — a manifest is
 * written by whoever wrote the package, so `"driver": "../../../.ssh/id_rsa"` is
 * a string peek would otherwise hand to `import()`.
 *
 * It is a *check*, not protection: decision 6 means a package's own
 * `driver.mjs` can read that file the moment it runs. What this buys is that a
 * package cannot reach outside itself **before** anyone has decided to run it,
 * which keeps "installed" and "executed" separable.
 */
function isContainedPath(raw: string): boolean {
  if (raw === '' || raw.startsWith('/') || raw.includes('\\') || /^[a-zA-Z]:/.test(raw)) return false
  return raw.split('/').every((segment) => segment !== '..' && segment !== '.')
}

const ContainedPathSchema = z
  .string()
  .min(1)
  .refine(isContainedPath, 'must be a relative path inside the package directory')

/**
 * The three files a package can offer, each named rather than assumed.
 *
 * Named rather than fixed by convention because the three run in three different
 * places (design §2.1) and the names are the only thing a reader of the manifest
 * has to tell them apart by. `driver` is required — a database package that
 * cannot open a connection is not one — while `contrib` and `ui` are what a
 * package adds when it has tools, view kinds, or a self-drawn view of its own.
 */
const PackageEntrySchema = z.object({
  /** Loaded by a driver-host process, one per connection */
  driver: ContainedPathSchema,
  /** Loaded by this package's own host process: MCP tools and view-kind code */
  contrib: ContainedPathSchema.optional(),
  /** Document root served at `peek-package://<id>/`, for a self-drawn view */
  ui: ContainedPathSchema.optional(),
})

/* ------------------------------------------------------------------ */
/* The manifest                                                        */
/* ------------------------------------------------------------------ */

/**
 * Three segments, and anything the package wants to say after them.
 *
 * §2.5 compares versions by the first three numbers and does not order
 * pre-release tags, so the schema demands exactly what the comparison reads and
 * lets the rest through unexamined — a full semver implementation would be the
 * one piece of code here with no consumer.
 */
const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+].*)?$/

export const PackageManifestSchema = z
  .object({
    /** The directory name, and the host of this package's `peek-package://` URLs */
    id: z.string().regex(PACKAGE_ID_PATTERN, 'must be lowercase letters, digits and hyphens'),
    /** This package's own version — the answer to "which build of this connector am I running" */
    version: z.string().regex(PACKAGE_VERSION_PATTERN, 'must be a version like 1.2.3'),
    /**
     * The peek versions this package was written against, as a range.
     *
     * Carried, not interpreted. What a range means is the loader's policy and
     * the loader's to change; a schema that refused `^0.1` for being the wrong
     * dialect of range would be a second opinion about it in the wrong file.
     */
    peek: z.string().min(1),
    drivers: z.array(PackageDriverSchema).min(1, 'a package with no driver contributes no database'),
    /**
     * The view kinds this package's `contrib.mjs` registers, data half only.
     *
     * Defaulted rather than left optional, unlike `redact`: there, absent and
     * `{}` are two different statements and collapsing them would delete a
     * warning; here a package that contributes no view kind and one that
     * contributes an empty list are the same package, and every consumer is a
     * loop. The file on disk still says nothing — `build-packages.mjs` writes
     * the candidate, not the parsed value.
     */
    viewKinds: z.array(PackageViewKindSchema).default([]),
    /** The MCP tools this package's `contrib.mjs` maps onto Commands, data half only. */
    tools: z.array(PackageToolSchema).default([]),
    entry: PackageEntrySchema,
  })
  .superRefine((manifest, ctx) => {
    // Two manifests under one id means a lookup answers with whichever was
    // registered last, and one database draws another's connect form.
    const ids = manifest.drivers.map((d) => d.driverId)
    const duplicate = ids.find((id, at) => ids.indexOf(id) !== at)
    if (duplicate !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['drivers'],
        message: `two drivers of this package are both '${duplicate}'`,
      })
    }

    // A view kind is offered on a connection by matching the connection's
    // driver, so naming one this package does not ship is not a no-op: the kind
    // appears on some *other* package's connection, and opening it forks this
    // host to plan a fetch — a Cypher statement aimed at PostgreSQL — against a
    // database it has never heard of.
    const shipped = new Set(ids)
    manifest.viewKinds.forEach((viewKind, at) => {
      for (const driverId of viewKind.driverIds) {
        if (shipped.has(driverId)) continue
        ctx.addIssue({
          code: 'custom',
          path: ['viewKinds', at, 'driverIds'],
          message: `'${driverId}' is not a driver this package ships, so '${viewKind.kind}' would be offered on a connection this package cannot read`,
        })
      }
    })

    // Both registries — main's and the renderer's — are keyed by `kind`, so a
    // repeated one is registered over itself and the view that opens is
    // whichever half was loaded last.
    const kinds = manifest.viewKinds.map((v) => v.kind)
    const duplicateKind = kinds.find((kind, at) => kinds.indexOf(kind) !== at)
    if (duplicateKind !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['viewKinds'],
        message: `two view kinds of this package are both '${duplicateKind}'`,
      })
    }

    // A tool name is what a model calls, and it is the only thing it has to go
    // on. Two declarations under one name reach the client as two tools that
    // cannot be told apart — the loader makes the same check across packages,
    // where the namespace is shared with everyone else's.
    const toolNames = manifest.tools.map((t) => t.name)
    const duplicateTool = toolNames.find((name, at) => toolNames.indexOf(name) !== at)
    if (duplicateTool !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: `two tools of this package are both named '${duplicateTool}'`,
      })
    }
  })

export type PackageManifest = z.infer<typeof PackageManifestSchema>

export type PackageManifestOutcome =
  | { ok: true; manifest: PackageManifest }
  | { ok: false; issues: readonly string[] }

/**
 * Read a parsed `peek-package.json`, or say what is wrong with it.
 *
 * The value is whatever `JSON.parse` returned; reading the file and reporting a
 * syntax error in it belong to the loader, which is the layer that knows the
 * path to put in front of the message.
 *
 * **An outcome, not a throw.** A bad manifest is one package failing to install,
 * not a reason for the scan to stop: the design asks for a report over the whole
 * directory rather than the first exception (§4.2), and `issues` is a list for
 * the same reason — a manifest with four things wrong with it should take one
 * round of fixing, not four.
 */
export function parsePackageManifest(value: unknown): PackageManifestOutcome {
  const parsed = PackageManifestSchema.safeParse(value)
  if (parsed.success) return { ok: true, manifest: parsed.data }
  return { ok: false, issues: zodIssueLines(parsed.error) }
}

/* ------------------------------------------------------------------ */
/* What the manifests become once a directory has been read            */
/* ------------------------------------------------------------------ */

/*
 * The three lists below are the manifests re-cut by consumer rather than by
 * package, and they are here — beside the schema rather than in the app that
 * fills them — for one reason: **the window is handed this value over IPC**
 * (`IPC.PACKAGES_READ`). It is a message body, and message bodies live in core
 * next to `StateSnapshotMessage` for the same reason those do.
 *
 * Every field is a `JSON.parse` product, which is not a coincidence and is the
 * property that makes the hard rule of §1.3 mechanical: what crosses to the
 * renderer is what a `structuredClone` can carry, so a package's code cannot
 * ride along even by accident. Nothing here has to be trusted on arrival
 * either — it left main already parsed by `PackageManifestSchema`.
 */

/** One driver, and the package directory the loader found it in. */
export interface InstalledDriver {
  /** The directory under `~/.peek/packages/`, which is also its package host's id. */
  readonly packageId: string
  /**
   * The whole of `DriverManifest`, including the `version` the file states once
   * for the package rather than once per driver.
   */
  readonly manifest: DriverManifest
}

/** One view kind's data half (§2.4bis(d)), tagged with the package that registers it. */
export interface InstalledViewKind extends PackageViewKind {
  readonly packageId: string
}

/**
 * One MCP tool's data half, tagged with the package whose host has to run it.
 *
 * An intersection rather than an `interface … extends`, because the declaration
 * is a discriminated union since §4duodevicies and an interface cannot extend
 * one. The tag rides on both branches, which is what `packageTools()` needs:
 * it switches on `kind` and then has to know where to send the call.
 */
export type InstalledTool = PackageToolDeclaration & { readonly packageId: string }

/**
 * Everything a process may know about the installed packages without running
 * any of their code.
 *
 * Three flat lists rather than a list of packages, because that is how all three
 * are read: the connect dialog wants every driver, `tools/list` wants every
 * tool, and neither cares which directory a row came from beyond the tag it
 * carries.
 */
export interface InstalledPackages {
  readonly drivers: readonly InstalledDriver[]
  readonly viewKinds: readonly InstalledViewKind[]
  readonly tools: readonly InstalledTool[]
}
