/**
 * The connection book: `~/.peek/connections.json`.
 *
 * ## Why there is no "save connection" button
 *
 * An entry is written as a side effect of a `conn.open` that **succeeded**, and
 * nowhere else. Two consequences, both deliberate:
 *
 *   - `conn.open` stays the only way a connection is described to peek. A second
 *     write path would be a second place for a config to be wrong, and only one
 *     of the two is ever proven correct by an actual handshake.
 *   - the book cannot fill up with connections that do not work. What is in it
 *     is exactly what has connected at least once from this machine.
 *
 * ## What is on disk
 *
 * The stored `config` has every credential **removed**, not masked: no
 * `password`, no `apiKey`, and a URL cut back to `scheme://user@host/db`. That
 * differs on purpose from `redactConnectionConfig`, which substitutes `***` — a
 * mask is right for something being displayed, and wrong for something that will
 * be sent back as a config to open, because `***` is a password the driver would
 * dutifully try. Removing the field instead means the worst case of a vault miss
 * is "no password given", which every driver already knows how to report.
 *
 * The credential travels separately, encrypted by the OS keychain through
 * `SecretVault`, and is merged back only in `hydrate`, inside main, on the way
 * to the driver host.
 *
 * ## Identity
 *
 * An entry is keyed by what *names a server and an account* — driver, host,
 * port, database, user — and not by the whole config. Ticking TLS or renaming
 * the connection updates the entry in place; pointing it at another host is a
 * different connection with a different credential. That line is also what stops
 * a saved password from being replayed at a server the user did not save it for.
 */

import { createHash } from 'node:crypto'
import {
  ConnectionConfigSchema,
  defaultConnectionLabel,
  type ConnectionConfig,
  type SavedConnection,
} from '@peek/core'
import { readJsonFile, writeJsonFile } from './json-file'
import { connectionsFilePath } from './paths'
import type { SecretVault } from './secrets'

/**
 * How many connections the book keeps. Past this the least recently used entry
 * is dropped — a viewer that has been pointed at hundreds of databases has a
 * history, not a connection list, and the file is read on every launch.
 */
export const MAX_BOOK_ENTRIES = 100

/** Fields held back from the file and sealed in the vault instead. */
interface StoredSecret {
  /**
   * The identity this credential belongs to, sealed **with** it.
   *
   * Recomputing the entry's id on read is not enough on its own: the id and the
   * sealed blob sit side by side in a file a human can edit, so rewriting the
   * host of an entry would otherwise hand the new host the old host's password —
   * a way to ask for a stored credential by editing a text file. Binding the
   * identity inside the ciphertext means the check cannot be edited out; only
   * the keychain could forge it.
   */
  identity: string
  password?: string
  apiKey?: string
  /** Only when the URL embedded credentials — the stored copy is scrubbed. */
  url?: string
}

interface StoredEntry {
  id: string
  label: string
  /** Redacted; see the note at the top of this file. */
  config: ConnectionConfig
  createdAt: string
  lastUsedAt: string
  /** Base64 ciphertext of a `StoredSecret`, absent when there is nothing to hide. */
  secret?: string
}

interface BookFile {
  version: 1
  entries: StoredEntry[]
}

export interface ConnectionBook {
  /** Newest use first. */
  list(): SavedConnection[]
  /** Record a config that just connected. Never throws: a save is not worth losing a connection over. */
  remember(config: ConnectionConfig): SavedConnection | null
  forget(id: string): boolean
  /**
   * Put the saved credential back into a config on its way to the driver.
   *
   * Only fills fields the caller left **absent**, and only from the entry with
   * the same identity, so a typed password always wins and a saved one is never
   * sent to a server it was not saved for.
   */
  hydrate(config: ConnectionConfig): ConnectionConfig
  readonly secretsAvailable: boolean
}

export interface ConnectionBookOptions {
  configDir: string
  vault: SecretVault
  /** Injected for tests, and so the timestamps of one save agree with each other. */
  now?: () => Date
  /** Reported rather than thrown: a book that cannot be written must not break connecting. */
  onError?: (message: string, detail: string) => void
}

export function createConnectionBook(options: ConnectionBookOptions): ConnectionBook {
  const path = connectionsFilePath(options.configDir)
  const now = options.now ?? ((): Date => new Date())
  const onError = options.onError ?? ((): void => {})
  const { vault } = options

  /** Loaded once, then kept in memory; this process is the only writer. */
  let entries: StoredEntry[] | null = null

  function load(): StoredEntry[] {
    if (entries !== null) return entries
    entries = parseBook(readJsonFile(path))
    return entries
  }

  function persist(next: StoredEntry[]): void {
    entries = next
    try {
      const file: BookFile = { version: 1, entries: next }
      writeJsonFile(path, file)
    } catch (error) {
      onError(
        'The connection book could not be saved.',
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return {
    get secretsAvailable() {
      return vault.available
    },

    list() {
      return load().map(toSavedConnection)
    },

    remember(config) {
      const id = identityId(config)
      const stripped = stripSecrets(config)
      const secret = extractSecret(config)
      const sealed = secret === null ? null : vault.seal(JSON.stringify(secret))
      if (secret !== null && sealed === null && vault.available) {
        onError(
          'The connection was saved without its password.',
          'The operating system keychain refused to encrypt it. peek never writes a credential in the clear.',
        )
      }

      const current = load()
      const previous = current.find((entry) => entry.id === id)
      const stamp = now().toISOString()
      const entry: StoredEntry = {
        id,
        // Derived from the stripped config: `defaultConnectionLabel` falls back
        // to the URL, and core masks a URL password as `***` on the way — right
        // for something being displayed, wrong for something being written down.
        label: defaultConnectionLabel(stripped),
        config: stripped,
        createdAt: previous?.createdAt ?? stamp,
        lastUsedAt: stamp,
        // A re-open that carried no password keeps the one already stored:
        // reconnecting from the book must not erase what makes it reusable.
        ...pickSecret(sealed, previous?.secret),
      }

      const next = [entry, ...current.filter((item) => item.id !== id)].slice(0, MAX_BOOK_ENTRIES)
      persist(next)
      return toSavedConnection(entry)
    },

    forget(id) {
      const current = load()
      const next = current.filter((entry) => entry.id !== id)
      if (next.length === current.length) return false
      persist(next)
      return true
    },

    hydrate(config) {
      const identity = connectionIdentity(config)
      const entry = load().find((item) => item.id === identityId(config))
      if (!entry?.secret) return config
      const opened = vault.open(entry.secret)
      if (opened === null) return config
      const secret = parseSecret(opened)
      // The identity sealed with the credential has to be the one being opened.
      // See `StoredSecret.identity`.
      if (secret === null || secret.identity !== identity) return config
      return mergeSecret(config, secret)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * The fields that name a server and an account.
 *
 * A URL is reduced to its password-free form for two reasons: the password
 * inside a URL never reaches the hash input, and the config that comes *back*
 * out of the book — which has no password by construction — still hashes to the
 * entry it came from. Normalizing both sides through the same function is what
 * makes `hydrate` find the credential it just saved.
 */
export function connectionIdentity(config: ConnectionConfig): string {
  const url = (value: string | undefined): string => (value === undefined ? '' : stripUrlPassword(value))
  switch (config.driverId) {
    case 'postgres':
    case 'mysql':
      return [
        config.driverId,
        url(config.url),
        config.host ?? '',
        config.port === undefined ? '' : String(config.port),
        config.database ?? '',
        config.user ?? '',
      ].join(' ')
    case 'redis':
      return [
        config.driverId,
        url(config.url),
        config.host ?? '',
        config.port === undefined ? '' : String(config.port),
        config.db === undefined ? '' : String(config.db),
        config.username ?? '',
      ].join(' ')
    case 'qdrant':
      return [config.driverId, url(config.url)].join(' ')
    case 'sqlite':
      return [config.driverId, config.file].join(' ')
  }
}

/**
 * Entry id: a digest of the identity, so it is the same across restarts and even
 * if the file is deleted and rebuilt. Truncated because it is an address in a
 * list of at most a hundred, not a security boundary.
 */
export function identityId(config: ConnectionConfig): string {
  return createHash('sha256').update(connectionIdentity(config)).digest('base64url').slice(0, 16)
}

/* ------------------------------------------------------------------ */
/* Secrets in and out of a config                                      */
/* ------------------------------------------------------------------ */

/**
 * Drop the password from a URL, keeping the user.
 *
 * Deliberately not core's `redactUrlCredentials`, which substitutes `***`: this
 * result is a config that will be *used*, and `***` is a password a driver would
 * send. The pattern is the same one core uses, so the two agree on what counts
 * as credentials in a URL.
 */
export function stripUrlPassword(url: string): string {
  return url.replace(/(:\/\/[^:/@]*):[^@]*@/, '$1@')
}

/** The config as it goes to disk: no password, no API key, no credentials in the URL. */
function stripSecrets(config: ConnectionConfig): ConnectionConfig {
  const draft: Record<string, unknown> = { ...config }
  delete draft['password']
  delete draft['apiKey']
  if (typeof draft['url'] === 'string') draft['url'] = stripUrlPassword(draft['url'])
  const parsed = ConnectionConfigSchema.safeParse(draft)
  // The parse cannot fail — only optional fields were removed — but falling back
  // to the input would put a password on disk, so fail closed on the label-only
  // shape instead.
  return parsed.success ? parsed.data : ({ driverId: config.driverId } as ConnectionConfig)
}

function extractSecret(config: ConnectionConfig): StoredSecret | null {
  const secret: StoredSecret = { identity: connectionIdentity(config) }
  if ('password' in config && config.password !== undefined) secret.password = config.password
  if ('apiKey' in config && config.apiKey !== undefined) secret.apiKey = config.apiKey
  // A URL only counts as a secret when it actually carries a password; the
  // stripped copy in the file is otherwise identical and there is nothing to hide.
  if ('url' in config && config.url !== undefined && stripUrlPassword(config.url) !== config.url) {
    secret.url = config.url
  }
  // `identity` alone is not a secret — there is nothing to seal.
  return Object.keys(secret).length === 1 ? null : secret
}

function mergeSecret(config: ConnectionConfig, secret: StoredSecret): ConnectionConfig {
  const draft: Record<string, unknown> = { ...config }
  // `in` rather than `!== undefined`: an explicitly blank password is a
  // different claim from an absent one (see the connect dialog), and only the
  // absent one may be filled from the vault.
  if (secret.password !== undefined && !('password' in config)) draft['password'] = secret.password
  if (secret.apiKey !== undefined && !('apiKey' in config)) draft['apiKey'] = secret.apiKey
  // The caller is holding the password-free URL out of the book. Only put the
  // credentials back when it is still exactly that — a URL the user retyped wins,
  // even if it happens to carry no password.
  if (secret.url !== undefined && draft['url'] === stripUrlPassword(secret.url)) {
    draft['url'] = secret.url
  }
  const parsed = ConnectionConfigSchema.safeParse(draft)
  return parsed.success ? parsed.data : config
}

function parseSecret(raw: string): StoredSecret | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const identity = record['identity']
    if (typeof identity !== 'string') return null
    const secret: StoredSecret = { identity }
    for (const key of ['password', 'apiKey', 'url'] as const) {
      const item = record[key]
      if (typeof item === 'string') secret[key] = item
    }
    return secret
  } catch {
    return null
  }
}

function pickSecret(sealed: string | null, previous: string | undefined): { secret?: string } {
  if (sealed !== null) return { secret: sealed }
  if (previous !== undefined) return { secret: previous }
  return {}
}

/* ------------------------------------------------------------------ */
/* File parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Read the file back, dropping anything that no longer fits the contract.
 *
 * Entry-by-entry rather than all-or-nothing: this file is hand-editable and
 * survives across peek versions, so one stale row must not cost the user the
 * other ninety-nine.
 */
function parseBook(raw: unknown): StoredEntry[] {
  if (typeof raw !== 'object' || raw === null) return []
  const list = (raw as Record<string, unknown>)['entries']
  if (!Array.isArray(list)) return []

  const out: StoredEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const entry = parseEntry(item)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
    if (out.length >= MAX_BOOK_ENTRIES) break
  }
  return out
}

function parseEntry(raw: unknown): StoredEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const parsed = ConnectionConfigSchema.safeParse(record['config'])
  if (!parsed.success) return null
  const config = parsed.data

  // The id is recomputed rather than trusted: it *is* the identity, and a
  // hand-edited host with the old id attached would otherwise hand that host the
  // previous server's password.
  const id = identityId(config)
  const label = typeof record['label'] === 'string' && record['label'] ? record['label'] : defaultConnectionLabel(config)
  const createdAt = isoOr(record['createdAt'])
  return {
    id,
    label,
    config,
    createdAt,
    lastUsedAt: isoOr(record['lastUsedAt'], createdAt),
    ...(typeof record['secret'] === 'string' && record['secret'].length > 0 ? { secret: record['secret'] } : {}),
  }
}

function isoOr(value: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof value !== 'string') return fallback
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString()
}

function toSavedConnection(entry: StoredEntry): SavedConnection {
  return {
    id: entry.id,
    driverId: entry.config.driverId,
    label: entry.label,
    config: entry.config,
    hasSecret: entry.secret !== undefined,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  }
}
