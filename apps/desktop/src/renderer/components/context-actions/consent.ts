/**
 * The disclosure gate: nothing leaves the machine until the user has been told
 * that it does.
 *
 * ## Why this exists at all
 *
 * peek is a database viewer. A user pointing it at a production PostgreSQL is
 * looking at customer names, order values and email addresses, and the mental
 * model of every other panel in this window is "this data is on my screen and
 * nowhere else". Attaching a row to the chat breaks that model: the rows are
 * serialized, embedded in a prompt and sent to Anthropic's API. That is the
 * feature working exactly as designed, and it is also the single most surprising
 * thing peek does — so it is stated once, plainly, before the first byte of data
 * is ever staged.
 *
 * ## What this is and is not
 *
 * It is a **one-time disclosure**, not a per-message confirmation. A dialog on
 * every attachment would be clicked through without reading within a day, which
 * is worse than no dialog: it trains the reflex that the warning means nothing.
 * One clear statement, acknowledged once, and thereafter a permanent (quiet)
 * marker on the chat panel is the honest shape.
 *
 * It is also **not a permission system**. The agent's own tool-call permissions
 * are ACP's `requestPermission`, and they are a different question entirely
 * ("may the model do this?" rather than "do you understand where this data
 * goes?"). Conflating them would give the user a single yes that answers two
 * unrelated questions.
 *
 * ## Persistence
 *
 * `localStorage`, keyed by a version. Bumping `CONSENT_VERSION` re-asks
 * everyone, which is what should happen if the disclosure's substance ever
 * changes — a stored acknowledgement of a sentence the user never saw is not an
 * acknowledgement. A storage that throws (private mode, a locked-down profile)
 * degrades to "not yet acknowledged", so the failure mode is asking again rather
 * than sending silently.
 */

/** Bump when the wording changes materially. Everyone is asked again. */
export const CONSENT_VERSION = 1

const STORAGE_KEY = 'peek.chat.contextConsent'

interface StoredConsent {
  version: number
  acceptedAt: number
}

let cached: StoredConsent | null | undefined
const listeners = new Set<() => void>()

function read(): StoredConsent | null {
  if (cached !== undefined) return cached
  cached = null
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as StoredConsent).version === 'number' &&
        typeof (parsed as StoredConsent).acceptedAt === 'number'
      ) {
        cached = parsed as StoredConsent
      }
    }
  } catch {
    // No storage, or unparseable. Treated as "never acknowledged": asking a
    // second time is a small annoyance, sending unannounced is not.
    cached = null
  }
  return cached
}

/**
 * Whether the user has seen and acknowledged the current disclosure.
 *
 * A stored acknowledgement from an older `CONSENT_VERSION` does not count.
 */
export function hasContextConsent(): boolean {
  const stored = read()
  return stored !== null && stored.version === CONSENT_VERSION
}

export function grantContextConsent(now: () => number = Date.now): void {
  const entry: StoredConsent = { version: CONSENT_VERSION, acceptedAt: now() }
  cached = entry
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entry))
  } catch {
    // The in-memory value still holds for this session, so the user is not asked
    // again every time they attach something within one run of the app.
  }
  emit()
}

/** Revoke, so the disclosure is shown again. Exists for a settings screen and for tests. */
export function revokeContextConsent(): void {
  cached = null
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to undo */
  }
  emit()
}

/** For `useSyncExternalStore`, so a dialog closing re-renders whatever gated on it. */
export function subscribeContextConsent(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Test seam: drops the memoised read so a test can control `localStorage` directly. */
export function resetContextConsentCache(): void {
  cached = undefined
  emit()
}

function emit(): void {
  for (const cb of [...listeners]) cb()
}
