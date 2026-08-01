import {
  ConnectionConfigSchema,
  type ConnectionConfig,
  type DriverId,
  type MessageArgs,
} from '@peek/core'
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
 * The zod parse at the end is not ceremony. `conn.open` validates the same
 * schema in main, and a rejection there arrives as a failed command with no
 * field to point at; catching it here means a typed port or an empty file path
 * is reported next to the box that caused it. The returned `issue` is zod's own
 * English text — a schema path, not prose, so it is not translated.
 */
export function buildConnectionConfig(
  driverId: DriverId,
  mode: ConnectMode,
  values: ConnectFormValues,
  label: string,
): BuildConfigOutcome {
  const draft = assemble(driverId, mode, values, label.trim())
  const parsed = ConnectionConfigSchema.safeParse(draft)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join('.') ?? ''
    return { ok: false, issue: path ? `${path}: ${first?.message ?? ''}` : (first?.message ?? 'invalid') }
  }
  return { ok: true, config: parsed.data }
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
