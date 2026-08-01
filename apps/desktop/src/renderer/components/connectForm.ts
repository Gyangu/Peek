import { ConnectionConfigSchema } from '@peek/core'
import type { ConnectionConfig, DriverId, MessageArgs } from '@peek/core'
import type { MessageKey, Messages } from '../i18n'

/**
 * Catalog keys that take no interpolation params.
 *
 * A field label arrives as data, so the component calls `t(field.labelKey)` with
 * a key it cannot know statically — and `t` requires a params argument exactly
 * when the message has placeholders. Narrowing the union to the parameterless
 * keys is what keeps that call type-safe instead of casting it away.
 */
export type PlainMessageKey = {
  [K in MessageKey]: MessageArgs<Messages[K]> extends [] ? K : never
}[MessageKey]

/* ==================================================================
 * The connect dialog's non-visual half.
 *
 * Five drivers, five different ways of naming the same idea: postgres takes a
 * URL or a host/port/database triple, redis adds a numeric database index that
 * is not part of the path, qdrant has no port-and-database at all (a base URL
 * plus an API key), and sqlite is a file on disk with no network identity
 * whatsoever. One text box cannot ask all of those questions honestly.
 *
 * So the shape of the form is data, declared once here, and `ConnectDialog`
 * only renders it. That split is what makes the interesting part — which fields
 * exist, which are required, and how they become a `ConnectionConfig` — testable
 * without a DOM, and it is why adding a sixth driver stays a table edit.
 *
 * Everything in this file is pure.
 * ================================================================== */

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

export interface ConnectField {
  /** Key into the form's value record, and the config property it fills */
  name: string
  type: ConnectFieldType
  labelKey: PlainMessageKey
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

export interface ConnectFormSpec {
  /** Available modes, the first being the default. A single-mode driver draws no picker. */
  modes: readonly ConnectMode[]
  fields: Readonly<Record<ConnectMode, readonly ConnectField[]>>
}

export type ConnectFormValues = Readonly<Record<string, string | boolean>>

/* ------------------------------------------------------------------ */
/* The forms                                                           */
/* ------------------------------------------------------------------ */

const URL_FIELD = (placeholder: string): ConnectField => ({
  name: 'url',
  type: 'text',
  labelKey: 'connect.field.url',
  placeholder,
  required: true,
  mono: true,
})

const CONNECT_FORMS: Readonly<Record<DriverId, ConnectFormSpec>> = {
  postgres: {
    modes: ['url', 'fields'],
    fields: {
      url: [URL_FIELD('postgresql://user@localhost:5432/database')],
      fields: [
        { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
        { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '5432', required: true },
        { name: 'database', type: 'text', labelKey: 'connect.field.database', required: true, mono: true },
        { name: 'user', type: 'text', labelKey: 'connect.field.user', mono: true },
        { name: 'password', type: 'password', labelKey: 'connect.field.password' },
        { name: 'ssl', type: 'checkbox', labelKey: 'connect.field.ssl' },
      ],
    },
  },
  mysql: {
    modes: ['url', 'fields'],
    fields: {
      url: [URL_FIELD('mysql://user:password@localhost:3306/database')],
      fields: [
        { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
        { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '3306', required: true },
        { name: 'database', type: 'text', labelKey: 'connect.field.database', required: true, mono: true },
        { name: 'user', type: 'text', labelKey: 'connect.field.user', defaultValue: 'root', mono: true },
        { name: 'password', type: 'password', labelKey: 'connect.field.password' },
        { name: 'ssl', type: 'checkbox', labelKey: 'connect.field.ssl' },
      ],
    },
  },
  // No URL mode: a file path is not a URL, and 'sqlite:///x' would be a spelling
  // peek invented. `readOnly` defaults on — this is a viewer, and the driver
  // refuses to create a database that is not there.
  sqlite: {
    modes: ['fields'],
    fields: {
      url: [],
      fields: [
        {
          name: 'file',
          type: 'text',
          labelKey: 'connect.field.file',
          placeholder: '/absolute/path/to/db.sqlite',
          required: true,
          mono: true,
        },
        { name: 'readOnly', type: 'checkbox', labelKey: 'connect.field.readOnly', defaultValue: true },
      ],
    },
  },
  redis: {
    modes: ['fields', 'url'],
    fields: {
      url: [URL_FIELD('redis://localhost:6379/0')],
      fields: [
        { name: 'host', type: 'text', labelKey: 'connect.field.host', defaultValue: 'localhost', required: true, mono: true },
        { name: 'port', type: 'number', labelKey: 'connect.field.port', defaultValue: '6379', required: true },
        // The logical database index, which redis keeps outside the connection's
        // identity: it is selected per client, not carried in the URL host part.
        { name: 'db', type: 'number', labelKey: 'connect.field.db', defaultValue: '0' },
        { name: 'username', type: 'text', labelKey: 'connect.field.username', mono: true },
        { name: 'password', type: 'password', labelKey: 'connect.field.password' },
        { name: 'tls', type: 'checkbox', labelKey: 'connect.field.tls' },
      ],
    },
  },
  qdrant: {
    modes: ['fields'],
    fields: {
      url: [],
      fields: [
        {
          name: 'url',
          type: 'text',
          labelKey: 'connect.field.qdrantUrl',
          placeholder: 'http://localhost:6333',
          defaultValue: 'http://localhost:6333',
          required: true,
          mono: true,
        },
        { name: 'apiKey', type: 'password', labelKey: 'connect.field.apiKey' },
      ],
    },
  },
}

export function connectFormSpec(driverId: DriverId): ConnectFormSpec {
  return CONNECT_FORMS[driverId]
}

/** The fields to draw for one driver in one mode. */
export function connectFields(driverId: DriverId, mode: ConnectMode): readonly ConnectField[] {
  return CONNECT_FORMS[driverId].fields[mode]
}

/** The mode a driver opens in. */
export function defaultConnectMode(driverId: DriverId): ConnectMode {
  return CONNECT_FORMS[driverId].modes[0] ?? 'fields'
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
 * The reverse of `assemble`: seed the form from a config that already exists.
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
  const spec = CONNECT_FORMS[driverId]
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
 */
export function buildConnectionConfig(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): BuildConfigOutcome {
  return validateConnectionConfig(assemble(driverId, mode, values, label.trim()))
}

/* ------------------------------------------------------------------ */
/* Draft -> ConnectionConfig                                           */
/* ------------------------------------------------------------------ */

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
 *    `capability.ts`, the same module as `DRIVER_CAPABILITIES`, which
 *    `state/capabilities.ts` needs in order to decide what a connection may be
 *    asked to do. That module is in the chunk before this file has an opinion.
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
 * The check is still worth doing on this side: `conn.open` validates in main
 * regardless, but a rejection from there arrives as a failed command with no
 * field to point at. Here it names the offending key, next to the box that
 * caused it.
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

function assemble(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): Record<string, unknown> {
  const base = label ? { label } : {}
  // Only the active mode's fields are read. A host typed before switching to URL
  // mode is still in the value record, and sending it as an override would
  // silently connect somewhere other than the URL on screen.
  const has = new Set(connectFields(driverId, mode).map((f) => f.name))
  const text = (name: string): string | undefined =>
    has.has(name) ? emptyToUndefined(readText(values, name)) : undefined
  const num = (name: string): number | undefined => {
    const raw = text(name)
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : Number.NaN // NaN survives to fail the zod parse loudly
  }
  const bool = (name: string): boolean | undefined =>
    has.has(name) ? (values[name] === true ? true : undefined) : undefined

  switch (driverId) {
    case 'postgres':
    case 'mysql':
      return {
        driverId,
        ...base,
        ...defined('url', text('url')),
        ...defined('host', text('host')),
        ...defined('port', num('port')),
        ...defined('database', text('database')),
        ...defined('user', text('user')),
        ...defined('password', text('password')),
        ...defined('ssl', bool('ssl')),
      }
    case 'sqlite':
      return {
        driverId,
        ...base,
        file: readText(values, 'file'),
        // Explicitly false rather than omitted: the driver's own default is
        // read-only, but "I unticked the box" has to survive the trip.
        readOnly: values['readOnly'] !== false,
      }
    case 'redis':
      return {
        driverId,
        ...base,
        ...defined('url', text('url')),
        ...defined('host', text('host')),
        ...defined('port', num('port')),
        ...defined('db', num('db')),
        ...defined('username', text('username')),
        ...defined('password', text('password')),
        ...defined('tls', bool('tls')),
      }
    case 'qdrant':
      return {
        driverId,
        ...base,
        url: readText(values, 'url'),
        ...defined('apiKey', text('apiKey')),
      }
  }
}

function defined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value }
}

function readText(values: ConnectFormValues, name: string): string {
  const raw = values[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

function emptyToUndefined(value: string): string | undefined {
  return value === '' ? undefined : value
}
