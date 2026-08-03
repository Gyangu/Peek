import { ConnectionConfigSchema } from '@peek/core'
import type {
  ConnectField as CoreConnectField,
  ConnectFormSpec as CoreConnectFormSpec,
  ConnectFormValues,
  ConnectMode,
  ConnectionConfig,
  DriverId,
  DriverManifest,
} from '@peek/core'
import { DRIVER_MANIFESTS } from '../../drivers/manifests'
import type { PlainMessageKey } from '../i18n'

/**
 * Catalog keys that take no interpolation params.
 *
 * Re-exported rather than declared: it moved to `i18n/catalog.ts` when the
 * plugin view-kind registry became a second consumer. Kept here so the connect
 * dialog's imports do not churn.
 */
export type { PlainMessageKey }

export type { ConnectFormValues, ConnectMode }
export type ConnectField = CoreConnectField<PlainMessageKey>
export type ConnectFormSpec = CoreConnectFormSpec<PlainMessageKey>

/* ==================================================================
 * The connect dialog's non-visual half.
 *
 * Five drivers, five different ways of naming the same idea: postgres takes a
 * URL or a host/port/database triple, redis adds a numeric database index that
 * is not part of the path, qdrant has no port-and-database at all (a base URL
 * plus an API key), and sqlite is a file on disk with no network identity
 * whatsoever. One text box cannot ask all of those questions honestly.
 *
 * So the shape of the form is data — and that data lives in each **driver
 * package's** manifest rather than in a table here. What a PostgreSQL connection
 * needs is a fact about PostgreSQL, and keeping it next to the driver is what
 * makes adding a database a package instead of an edit to every consumer that
 * had an opinion about it. This module is what the window does with that data:
 * resolve a driver to its form, seed values, validate, assemble.
 *
 * Everything here is pure.
 * ================================================================== */

/**
 * The manifests, re-declared with the message-key type filled in.
 *
 * **This annotation is the check.** `DRIVER_MANIFESTS` carries each package's
 * literal `labelKey`s — see `defineManifest` in core, and the deliberate absence
 * of a type annotation on the array itself — and naming `PlainMessageKey` here
 * is what measures every one of them against the real catalog. A driver package
 * that invents `connect.field.hostname` fails to compile *on this line*, with
 * the offending key in the message, rather than shipping a dialog whose label
 * renders as the key itself.
 *
 * It also rules out a key that *exists* but takes interpolation parameters,
 * which `t(field.labelKey)` could not call with one argument.
 */
const MANIFESTS: readonly DriverManifest<PlainMessageKey>[] = DRIVER_MANIFESTS

const BY_ID = new Map<DriverId, DriverManifest<PlainMessageKey>>(
  MANIFESTS.map((m) => [m.driverId, m]),
)

/**
 * The manifest behind a driver id.
 *
 * Throws rather than returning null: every caller here is already committed to
 * drawing a form, and there is nothing sensible to draw for a driver that has
 * none. `ConnectDialog` only ever offers ids from `DRIVER_IDS`, and
 * `driver-registry.test.ts` asserts that list and this one agree, so a miss is a
 * wiring bug rather than a state the UI has to handle.
 */
function manifest(driverId: DriverId): DriverManifest<PlainMessageKey> {
  const found = BY_ID.get(driverId)
  if (found === undefined) throw new Error(`No driver manifest for ${driverId}`)
  return found
}

export function connectFormSpec(driverId: DriverId): ConnectFormSpec {
  return manifest(driverId).connectForm
}

/** The fields to draw for one driver in one mode. */
export function connectFields(driverId: DriverId, mode: ConnectMode): readonly ConnectField[] {
  return manifest(driverId).connectForm.fields[mode]
}

/** The mode a driver opens in. */
export function defaultConnectMode(driverId: DriverId): ConnectMode {
  return manifest(driverId).connectForm.modes[0] ?? 'fields'
}

/** Initial values, so switching driver or mode lands on a form that is ready to submit. */
export function initialConnectValues(driverId: DriverId, mode: ConnectMode): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {}
  for (const field of connectFields(driverId, mode)) {
    values[field.name] = field.defaultValue ?? (field.type === 'checkbox' ? false : '')
  }
  return values
}

/* ------------------------------------------------------------------ */
/* ConnectionConfig → form values (editing a saved connection)         */
/* ------------------------------------------------------------------ */

/**
 * The reverse of a manifest's `assembleConfig`: seed the form from a config that
 * already exists.
 *
 * This is what makes a saved connection **editable** rather than merely
 * repeatable. Before it, correcting a port meant retyping a host, a database, a
 * user and a password, which is why the connect dialog only ever had one button.
 *
 * Two rules keep it honest:
 *   - the mode is chosen from the config, not guessed. A config carrying a `url`
 *     opens in URL mode, because that is the field its identity is in; showing
 *     it as an empty host/port pair would look like a different connection.
 *   - fields the config does not have keep the form's defaults, so a driver that
 *     gains a field later does not seed it as blank.
 *
 * Passwords are never here: the config out of the connection book has none, by
 * construction. The dialog says so instead of pretending the box is filled.
 */
export function connectModeFor(driverId: DriverId, config: Readonly<Record<string, unknown>>): ConnectMode {
  const spec = manifest(driverId).connectForm
  const hasUrl = typeof config['url'] === 'string' && config['url'].length > 0
  // qdrant's `url` is a plain field, not a mode — it has no URL mode to switch to.
  if (hasUrl && spec.modes.includes('url')) return 'url'
  return defaultConnectMode(driverId)
}

export function valuesFromConfig(
  driverId: DriverId,
  mode: ConnectMode,
  config: Readonly<Record<string, unknown>>,
): Record<string, string | boolean> {
  const values = initialConnectValues(driverId, mode)
  for (const field of connectFields(driverId, mode)) {
    const raw = config[field.name]
    if (raw === undefined) continue
    if (field.type === 'checkbox') {
      if (typeof raw === 'boolean') values[field.name] = raw
    } else if (typeof raw === 'string') {
      values[field.name] = raw
    } else if (typeof raw === 'number') {
      values[field.name] = String(raw)
    }
  }
  return values
}

/** Names of the required fields still blank. Empty means the form can be submitted. */
export function missingRequiredFields(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
): string[] {
  return connectFields(driverId, mode)
    .filter((f) => f.required === true && readText(values, f.name) === '')
    .map((f) => f.name)
}

/* ------------------------------------------------------------------ */
/* Values → ConnectionConfig                                           */
/* ------------------------------------------------------------------ */

export type BuildConfigOutcome =
  | { ok: true; config: ConnectionConfig }
  | { ok: false; issue: string }

/**
 * Assemble a `ConnectionConfig` and check it against the contract before it
 * leaves the window.
 *
 * The check at the end is not ceremony. `conn.open` validates the real schema in
 * main, and a rejection there arrives as a failed command with no field to point
 * at; catching it here means a typed port or an empty file path is reported next
 * to the box that caused it. The returned `issue` names the offending key — a
 * schema path, not prose, so it is not translated.
 *
 * The assembly itself belongs to the driver: which form fields become which
 * config properties, and what an empty box means for each of them, is knowledge
 * about that one database.
 */
export function buildConnectionConfig(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): BuildConfigOutcome {
  return validateConnectionConfig(manifest(driverId).assembleConfig(mode, values, label.trim()))
}

/**
 * Check one assembled draft against the real contract schema.
 *
 * ## Why the schema, and not a hand-written mirror of it
 *
 * This call was once rewritten as a table of per-driver field rules, on the
 * premise that it was the renderer's only runtime use of zod and therefore the
 * one thing dragging the library into the window's chunk. Both halves of that
 * premise are false, and both were measured rather than argued:
 *
 * 1. **zod is in the renderer chunk either way.** `packages/core`'s `ids.ts` and
 *    `errors.ts` are built on it, and the renderer uses both on every command it
 *    sends and every error it renders. Dropping this one call leaves `ZodError`
 *    and the whole runtime in the bundle regardless — checked by grepping the
 *    built asset, not by reading imports.
 * 2. **`ConnectionConfigSchema` costs nothing extra here.** It is declared in
 *    `capability.ts`, a module the renderer is already carrying for
 *    `ConnectionState` and the command schemas, before this file has an opinion.
 *
 * So the mirror bought no bytes and spent some. A/B of the built renderer chunk,
 * everything else identical (esbuild-minified, `pnpm build`):
 *
 *   hand-written rule table   533,140 B
 *   ConnectionConfigSchema    531,272 B   (-1,868 B)
 *
 * On top of the bytes, the table was a second copy of a contract that main
 * enforces for real — correct only for as long as someone remembered to edit it
 * twice. Calling the schema is smaller, shorter, and cannot drift.
 *
 * **It is also why a `DriverManifest` carries no config schema of its own.** The
 * union discriminates on `driverId`, so parsing the whole thing selects the
 * right branch unaided; a per-package copy would be a second description of a
 * contract that main enforces — the mistake this comment already records once.
 */
export function validateConnectionConfig(draft: Record<string, unknown>): BuildConfigOutcome {
  const parsed = ConnectionConfigSchema.safeParse(draft)
  if (parsed.success) return { ok: true, config: parsed.data }
  // The first issue only. The form reports next to a field, and a list of five
  // messages for one bad port reads as five problems. `path: message` is a
  // schema path rather than prose, so it is deliberately not translated.
  const issue = parsed.error.issues[0]
  return {
    ok: false,
    issue: issue === undefined ? 'invalid' : `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  }
}

function readText(values: ConnectFormValues, name: string): string {
  const raw = values[name]
  return typeof raw === 'string' ? raw.trim() : ''
}
