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
 * The stored `config` has every credential **removed**, not masked. Which fields
 * those are is the driver package's `redact` declaration, the same one every
 * other scrubbing path reads; for the six built in it means no `password`, no
 * `apiKey`, and a URL cut back to `scheme://user@host/db`. Removal
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
 * Both scrubbings appear in the file, side by side, and that is the point rather
 * than a slip: a `***` does show up in `display.detail`, because that string is
 * a tooltip and a mask is right for something being *displayed*. What a driver
 * dials is `config`, and `config` has no mask anywhere in it.
 *
 * ## Identity
 *
 * An entry is keyed by what *names a server and an account* — driver, host,
 * port, database, user — and not by the whole config. Ticking TLS or renaming
 * the connection updates the entry in place; pointing it at another host is a
 * different connection with a different credential. That line is also what stops
 * a saved password from being replayed at a server the user did not save it for.
 *
 * *Which* fields those are is now the driver package's declaration
 * (`DriverManifest.identity`) rather than a switch in core, but the joining is
 * still the kernel's and deliberately so: a package that could compute an
 * identity could make its connection collide with another one and read that
 * connection's password back out of the keychain. `connectionIdentityOf` is the
 * seam, and it is the whole reason this file reaches for the manifests at all.
 */

import { createHash } from 'node:crypto'
import { stripUrlPassword, type ConnectionConfig, type SavedConnection } from '@peek/core'
import { connectionIdentityOf, parseConnectionConfig, redactRulesFor } from '../../drivers/manifests'
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

/**
 * What this connection is *called*, as the package that owns the driver computed
 * it — stored rather than derived on read, which is design §2.3(b-2) and a
 * reversal of what this file used to say.
 *
 * The old arrangement derived both strings in `toSavedConnection`, so that a
 * change to how names are derived reached entries saved by an older version.
 * That is a real property and it is being given up on purpose: deriving them
 * means calling the package's code, the package's code runs in its own host
 * process (§2.4bis), and `book.list()` answers on the launch path with the
 * sidebar waiting and no host started. Naming a hundred archived rows is not
 * worth forking six processes, and it is not worth an asynchronous `list()`
 * either.
 *
 * What makes storing them sound is the same fact §2.3(b) leans on for a live
 * connection: **a config never changes**. Editing one produces a different
 * config, which goes through `remember` again, so the pair is recomputed exactly
 * when the thing it describes changes.
 *
 * An empty string means "nobody has computed this yet" — an entry written before
 * this field existed, or one whose `describeConnection` did not come back. No
 * package returns an empty label for a config it recognises, so the two cannot
 * be confused.
 */
export interface StoredDisplay {
  /** As the sidebar row shows it. Already has the `config.label ||` rule applied. */
  label: string
  /** The long form the label had to drop, for that row's tooltip. */
  detail: string
}

/**
 * A row of the file.
 *
 * `display` is nested rather than two keys on the entry, and that is not
 * cosmetic: a top-level `label` is a key an older peek may have written next to
 * a row, and this file has always ignored it (see `parseEntry`) precisely
 * because it was a *derived* value frozen at whatever that version derived.
 * Reusing the name would make an old row's stale copy indistinguishable from a
 * new row's authoritative one. Nesting also says the two strings are one answer,
 * arrived at in one moment by one package.
 */
interface StoredEntry {
  id: string
  /** Redacted; see the note at the top of this file. */
  config: ConnectionConfig
  createdAt: string
  lastUsedAt: string
  /** Absent for an entry that has never been named; see {@link StoredDisplay}. */
  display?: StoredDisplay
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
  /**
   * Record a config that just connected. Never throws: a save is not worth losing
   * a connection over.
   *
   * `display` is what the owning package called this connection, which the caller
   * is holding because the connection it just opened was named a moment ago (see
   * `describeConnection`). It is a parameter rather than something this file
   * derives because deriving it is running a package's code, and main runs none
   * — §2.3(b-2). Empty strings are allowed and mean "not named"; the entry then
   * keeps whatever pair it already had.
   */
  remember(config: ConnectionConfig, display: StoredDisplay): SavedConnection | null
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

    remember(config, display) {
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
        config: stripped,
        createdAt: previous?.createdAt ?? stamp,
        lastUsedAt: stamp,
        ...pickDisplay(display, previous?.display),
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
      const identity = connectionIdentityOf(config)
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
 * Entry id: a digest of the identity, so it is the same across restarts and even
 * if the file is deleted and rebuilt. Truncated because it is an address in a
 * list of at most a hundred, not a security boundary.
 */
export function identityId(config: ConnectionConfig): string {
  return createHash('sha256').update(connectionIdentityOf(config)).digest('base64url').slice(0, 16)
}

/* ------------------------------------------------------------------ */
/* Secrets in and out of a config                                      */
/* ------------------------------------------------------------------ */

/**
 * The config as it goes to disk: every field the driver calls a secret is gone,
 * and a URL keeps everything but its password.
 *
 * Driven by that driver's `redact` rules rather than by field names spelled out
 * here. The three names this used to handle itself are exactly what the six
 * built-in packages declare, so nothing about their behaviour moves; what moves
 * is a package peek does not compile in. One naming its credential `token` gets it
 * scrubbed from the MCP receipt and the renderer broadcast already — this was the
 * last path that would still have written it to `~/.peek/connections.json` in the
 * clear.
 *
 * `extractSecret` / `mergeSecret` on the other side still name the three, and the
 * asymmetry fails closed: a `token` is removed here but never sealed, so it is
 * forgotten rather than leaked and the connection asks for it again. Sealing an
 * arbitrary field set is the loader's problem and deliberately not this one's.
 */
function stripSecrets(config: ConnectionConfig): ConnectionConfig {
  const draft: Record<string, unknown> = { ...config }
  for (const [name, rule] of Object.entries(redactRulesFor(config.driverId))) {
    if (rule === 'value') {
      delete draft[name]
      continue
    }
    const value = draft[name]
    if (typeof value === 'string') draft[name] = stripUrlPassword(value)
  }
  const stripped = parseConnectionConfig(draft, 'keep')
  // Only optional fields go for the six built in, so the parse cannot fail for
  // them — but a `'value'` rule on a *required* field would leave a shape the
  // driver's own field list refuses, and falling back to the input would put the
  // secret on disk. Fail closed on the id-only shape instead: a useless entry is
  // the right kind of broken.
  return stripped ?? { driverId: config.driverId }
}

function extractSecret(config: ConnectionConfig): StoredSecret | null {
  const secret: StoredSecret = { identity: connectionIdentityOf(config) }
  const password = stringField(config, 'password')
  const apiKey = stringField(config, 'apiKey')
  const url = stringField(config, 'url')
  if (password !== null) secret.password = password
  if (apiKey !== null) secret.apiKey = apiKey
  // A URL only counts as a secret when it actually carries a password; the
  // stripped copy in the file is otherwise identical and there is nothing to hide.
  if (url !== null && stripUrlPassword(url) !== url) secret.url = url
  // `identity` alone is not a secret — there is nothing to seal.
  return Object.keys(secret).length === 1 ? null : secret
}

/**
 * One field of a config, when it is a string.
 *
 * `'password' in config && config.password !== undefined` said this while the
 * config was a union of six shapes core declared, because `in` narrowed to the
 * branches that had the field and the branch typed it. A config is an open
 * record now, so its fields read as `unknown` and the type has to be checked
 * rather than narrowed to. The three fields this is asked about are the three
 * `StoredSecret` can hold, and a non-string one is a hand-edited file rather
 * than anything peek writes.
 */
function stringField(config: ConnectionConfig, name: string): string | null {
  const value = config[name]
  return typeof value === 'string' ? value : null
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
  const merged = parseConnectionConfig(draft, 'keep')
  return merged ?? config
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
/* The two strings that name an entry                                  */
/* ------------------------------------------------------------------ */

/**
 * A name that did not arrive keeps the one already stored — the same shape as
 * `pickSecret` above, and the same reason underneath it.
 *
 * `describeConnection` is best-effort: a package host that was slow or that
 * crashed leaves the live connection unnamed, and the connect it was planned in
 * front of succeeds anyway. Writing that blank through would turn a display
 * hiccup into a permanently downgraded row in a file that outlives the process,
 * which is the one thing storing the strings makes possible and deriving them
 * never could.
 */
function pickDisplay(next: StoredDisplay, previous: StoredDisplay | undefined): { display?: StoredDisplay } {
  return displayOrNothing(next.label || previous?.label, next.detail || previous?.detail)
}

/** Absent rather than a pair of empty strings: a row nobody has named says nothing. */
function displayOrNothing(
  label: string | undefined,
  detail: string | undefined,
): { display?: StoredDisplay } {
  if (!label && !detail) return {}
  return { display: { label: label ?? '', detail: detail ?? '' } }
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
  // Against the registry, not core's open schema. An entry naming a driver this
  // build has no manifest for has to be dropped here: `identityId` below asks
  // that manifest which fields identify a connection, and there is no safe
  // guess — an empty list or all fields differ by whether every such connection
  // collapses onto one keychain entry. It used to be dropped by the config union
  // refusing the id; now it is dropped by the lookup missing.
  const config = parseConnectionConfig(record['config'], 'keep')
  if (config === null) return null

  // The id is recomputed rather than trusted: it *is* the identity, and a
  // hand-edited host with the old id attached would otherwise hand that host the
  // previous server's password.
  const id = identityId(config)
  // A `label` key written by an older version is ignored on purpose — see the
  // note on `StoredEntry`.
  const createdAt = isoOr(record['createdAt'])
  return {
    id,
    config,
    createdAt,
    lastUsedAt: isoOr(record['lastUsedAt'], createdAt),
    ...parseDisplay(record['display']),
    ...(typeof record['secret'] === 'string' && record['secret'].length > 0
      ? { secret: record['secret'] }
      : {}),
  }
}

/**
 * The stored pair, or nothing.
 *
 * Field by field rather than all-or-nothing, like `parseBook` is row by row: the
 * file is hand-editable, and half a name is still a name worth showing.
 */
function parseDisplay(raw: unknown): { display?: StoredDisplay } {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const label = record['label']
  const detail = record['detail']
  return displayOrNothing(
    typeof label === 'string' ? label : undefined,
    typeof detail === 'string' ? detail : undefined,
  )
}

function isoOr(value: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof value !== 'string') return fallback
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString()
}

/**
 * The read side of {@link StoredDisplay}: an entry saved before the book stored
 * these — or one that has never been named — falls back to what the config
 * itself says, and finally to the driver id.
 *
 * There is no backfill here and no migration pass at launch, which is §2.3(b-2)
 * rule 2: computing the real name means asking the package, asking the package
 * means starting its host, and starting six hosts to draw a sidebar is the cost
 * this whole change exists to avoid. The row is named properly the next time it
 * connects. What it shows until then — the user's own `label`, or the driver id
 * — is what peek showed before there was a derived name at all.
 */
function displayedLabel(entry: StoredEntry): string {
  return entry.display?.label || entry.config.label || entry.config.driverId
}

function toSavedConnection(entry: StoredEntry): SavedConnection {
  return {
    id: entry.id,
    driverId: entry.config.driverId,
    identity: connectionIdentityOf(entry.config),
    label: displayedLabel(entry),
    // No fallback of its own: `detail` is a tooltip, and inventing a long form
    // for a row whose short form is already a guess would only look authoritative.
    detail: entry.display?.detail ?? '',
    config: entry.config,
    hasSecret: entry.secret !== undefined,
    createdAt: entry.createdAt,
    lastUsedAt: entry.lastUsedAt,
  }
}
