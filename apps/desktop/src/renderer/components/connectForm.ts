import { assembleFromForm, parseConnectionConfig } from '@peek/core'
import type {
  ConnectField,
  ConnectFormSpec,
  ConnectFormValues,
  ConnectMode,
  ConnectionConfig,
  DriverId,
  DriverManifest,
  SavedConnection,
} from '@peek/core'
import { connectFormOf, lookupManifest } from '../../drivers/manifests'
import type { PlainMessageKey } from '../i18n'

/**
 * Catalog keys that take no interpolation params.
 *
 * Re-exported rather than declared: it moved to `i18n/catalog.ts` when the
 * package view-kind registry became a second consumer. Kept here so the connect
 * dialog's imports do not churn.
 */
export type { PlainMessageKey }

export type { ConnectField, ConnectFormSpec, ConnectFormValues, ConnectMode }

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
 * The manifests, as this module reads them.
 *
 * **This line used to be a compile-time check and is not one any more.** It read
 * `readonly DriverManifest<PlainMessageKey>[]`, and that annotation measured
 * every package's `labelKey` against the window's real message catalog: a driver
 * inventing `connect.field.hostname` failed to compile here, naming the key.
 *
 * Decision 3 (design 2026-08-07 §2.3c) removed what it was checking rather than
 * the check — a package carries its own text now, so there is no key and no
 * catalog to measure it against. Nothing about that is free: the guarantee went
 * from "tsc names the offending key" to "the loader refuses a field whose
 * `label` has no `en`" (`PackageConnectFieldSchema`), which is a runtime refusal
 * at install time rather than a build failure. It is also the only guarantee
 * that could ever have covered a package peek did not build, which is why the
 * trade is the right way round even though it is a downgrade for the five
 * in-repo ones.
 *
 * What is *not* replaced is wording consistency. Six packages each spelling
 * "Host" is six chances to write "Hostname"; §2.3c states that outright, and the
 * answer is people, not types.
 */
/**
 * The manifest behind a driver id.
 *
 * Throws rather than returning null: every caller here is already committed to
 * drawing a form, and there is nothing sensible to draw for a driver that has
 * none. `ConnectDialog` fills its picker from `manifestDriverIds()` — the same
 * registry this reads — so nothing the user can *select* misses. It used to fill
 * it from core's `DRIVER_IDS` and `driver-registry.test.ts` kept the two lists
 * agreeing; the picker now asks the registry directly, which is one list instead
 * of two.
 *
 * **A miss is not a wiring bug**, which is what this comment claimed until
 * design 2026-08-11. Phase C made packages uninstallable, so any driver id held
 * somewhere older than the current registry can arrive here with nothing behind
 * it: an entry in the connection book, the `initial` this dialog was seeded
 * with, or the selection of a dialog that was already open when the package went
 * away. The throw stays — a form really is undrawable without a manifest — but
 * the job of not reaching it moved to the caller. `ConnectDialog` measures its
 * driver against `manifestDriverIds()` before it calls anything in this file and
 * reports the miss itself, because this throw happens during a render, and a
 * render that throws takes the entire window down with it.
 *
 * There was a `Map` here, built once at module load off the compiled-in list.
 * The list arrives over IPC now (`drivers/installed.ts`) and is installed before
 * the first render, so the index it would have been built from moved there —
 * one map, filled once, rather than one per module that wanted a lookup.
 */
function manifest(driverId: DriverId): DriverManifest {
  const found = lookupManifest(driverId)
  if (found === null) throw new Error(`No driver manifest for ${driverId}`)
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

/**
 * Which driver a blank form opens on — the connection book's answer, not a
 * compiled-in one.
 *
 * This used to be the literal `'postgres'`, and it was the last database name
 * left in the window after Phase C moved the list to disk: design §1.4 says the
 * window holds no compiled-in list of databases, and a list of one is still a
 * list. It was also fatal rather than wrong — uninstalling the postgres package
 * made the seed a lookup for a manifest that is not there, and the throw took
 * the window with it (design 2026-08-11 §1.2).
 *
 * Three levels, in order:
 *
 *   1. the driver of the most recently used entry in the book **that is still
 *      installed**. The filter is not politeness: without it, uninstalling the
 *      one database you actually use brings the same throw back through a
 *      different door;
 *   2. the first installed driver, which is the loader's order (package
 *      directories sorted by name) and therefore stable across machines but
 *      arbitrary — nobody chose it, and today it is neo4j;
 *   3. null, when nothing is installed at all. A legal state since Phase C, and
 *      the caller's to draw rather than this module's to paper over.
 *
 * Why the book and not "the first installed driver" alone: level 2 is the answer
 * when there is no evidence, and level 1 is the evidence. Someone whose book is
 * all PostgreSQL gets PostgreSQL — the behaviour the literal used to give them —
 * and someone whose book is all Redis gets Redis, which it never did.
 *
 * The comparison is lexicographic on `lastUsedAt` because the book writes it
 * with `toISOString()` (`config/connection-book.ts`), which is fixed-width UTC:
 * string order is time order, and parsing dates to compare them would be the
 * same answer with a `NaN` case added. Ties keep the earlier entry, so the
 * result does not depend on the order the book happened to list them in.
 *
 * Both arguments are passed rather than read from the registry here for the
 * reason `ConnectFormLookup` gives below — and this one is also the function
 * whose empty-registry case has to be testable without an empty registry.
 */
export function seedDriverId(
  saved: readonly SavedConnection[],
  installed: readonly DriverId[],
): DriverId | null {
  const available = new Set(installed)
  let best: SavedConnection | null = null
  for (const entry of saved) {
    if (!available.has(entry.driverId)) continue
    if (best === null || entry.lastUsedAt > best.lastUsedAt) best = entry
  }
  return best?.driverId ?? installed[0] ?? null
}

/* ------------------------------------------------------------------ */
/* ConnectionConfig → form values (editing a saved connection)         */
/* ------------------------------------------------------------------ */

/**
 * The reverse of `assembleFromForm`: seed the form from a config that already
 * exists.
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
 * **The assembly is core's, not the driver's** — the opposite of what this
 * comment used to say. It was `manifest.assembleConfig`, a method every package
 * wrote, on the reading that "which form field becomes which config property"
 * was knowledge about one database. Reading the five implementations side by
 * side is what refuted that: none of them renamed a field, computed one, or
 * moved a value anywhere but the config key of the same name, so it was one
 * convention typed five times rather than five answers. `assembleFromForm`
 * states it once; its header carries the convention and the two cases it could
 * not absorb.
 *
 * What stayed the driver's is the *form* — `connectForm` above, which is still
 * the package's declaration and still the only thing that decides what a user is
 * asked for.
 */
export function buildConnectionConfig(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): BuildConfigOutcome {
  return validateConnectionConfig(
    assembleFromForm(manifest(driverId), mode, values, label.trim()),
    connectFormOf,
  )
}

/**
 * Where a driver's field declarations come from.
 *
 * A parameter rather than a module-level table, and not for testability: in
 * Phase C the manifests arrive over IPC from main instead of being imported, so
 * "which fields does this driver have" stops being a synchronous fact this file
 * can reach for. Taking it as an argument is what lets the dialog's data source
 * change without this module changing with it.
 *
 * Null for an id no manifest claims — which `validateConnectionConfig` reports
 * rather than shrugging at. That refusal is the one this call inherited from the
 * closed union: a `driverId` outside the six was a parse failure, and it still
 * has to be, or the dialog sends main a config no package can open.
 */
export type ConnectFormLookup = (driverId: DriverId) => ConnectFormSpec | null

/**
 * Check one assembled draft against the contract, and name the field that failed.
 *
 * ## Why a real parse, and not a hand-written mirror of one
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
 * 2. **The parse costs nothing extra here.** It is built out of `capability.ts`
 *    and `manifest.ts`, two modules the renderer is already carrying for
 *    `ConnectionState`, the command schemas and the connect form itself, before
 *    this file has an opinion.
 *
 * So the mirror bought no bytes and spent some. A/B of the built renderer chunk,
 * everything else identical (esbuild-minified, `pnpm build`):
 *
 *   hand-written rule table   533,140 B
 *   ConnectionConfigSchema    531,272 B   (-1,868 B)
 *
 * On top of the bytes, the table was a second copy of a contract that main
 * enforces for real — correct only for as long as someone remembered to edit it
 * twice.
 *
 * **And it is still one contract, now that the union has gone.** `conn.open`
 * validates the same way in main — core's `parseConnectionConfig`, against the
 * same manifest's `connectForm` — so a draft this accepts is a draft main
 * accepts, which is the whole reason to check here at all: a rejection in main
 * arrives as a failed command with no field to point at.
 *
 * `'drop'`: an accepted config carries only what the driver's form declares.
 * That is what the *dialog* needs — a value left over from the other mode must
 * not survive — and deliberately not what main uses when reading a config back
 * off disk, where an undeclared key is one an MCP caller meant.
 */
export function validateConnectionConfig(
  draft: Record<string, unknown>,
  formOf: ConnectFormLookup,
): BuildConfigOutcome {
  const driverId = draft['driverId']
  const form = typeof driverId === 'string' ? formOf(driverId) : null
  if (form === null) {
    return { ok: false, issue: `driverId: no database package provides '${String(driverId)}'` }
  }
  const parsed = parseConnectionConfig(draft, form, 'drop')
  if (parsed.ok) return { ok: true, config: parsed.config }
  // The first issue only. The form reports next to a field, and a list of five
  // messages for one bad port reads as five problems. `path: message` is a
  // schema path rather than prose, so it is deliberately not translated.
  return { ok: false, issue: parsed.issues[0] ?? 'invalid' }
}

function readText(values: ConnectFormValues, name: string): string {
  const raw = values[name]
  return typeof raw === 'string' ? raw.trim() : ''
}
