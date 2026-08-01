/**
 * Credential storage, on top of Electron's built-in `safeStorage`.
 *
 * `safeStorage` hands the key to the OS — Keychain on macOS, DPAPI on Windows,
 * libsecret/kwallet on Linux — which is the only reason peek is willing to keep
 * a database password on disk at all. No dependency is added for this; peek
 * shipped with a "nothing is persisted" promise and the smallest honest way to
 * break it is to let the operating system hold the key.
 *
 * **The vault never falls back to plaintext.** On a Linux box with no keyring,
 * or before the app is ready, `isEncryptionAvailable()` is false, and this
 * module then refuses to store the secret rather than writing it in the clear.
 * The connection is still saved; only its password is missing, and
 * `available` is reported all the way out to `conn.book.list` so a UI can say
 * why instead of silently losing a password each time.
 *
 * Electron is injected rather than imported: everything here is unit-testable
 * with a fake, and this module stays loadable outside an Electron runtime.
 */

/** The slice of Electron's `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SecretVault {
  /** False when the OS keychain is unusable; nothing will be stored. */
  readonly available: boolean
  /** Base64 of the ciphertext, or null when it could not be encrypted. */
  seal(plaintext: string): string | null
  /** Plaintext, or null when the payload is corrupt or from another machine. */
  open(sealed: string): string | null
}

/** A vault that stores nothing and admits it. Used when Electron is absent. */
export const unavailableVault: SecretVault = {
  available: false,
  seal: () => null,
  open: () => null,
}

export function createSafeStorageVault(safeStorage: SafeStorageLike): SecretVault {
  // Probed once per process: on some Linux desktops the check shells out to the
  // keyring daemon, and the connection book asks this question on every save.
  let available: boolean
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }

  return {
    available,
    seal(plaintext) {
      if (!available) return null
      try {
        return safeStorage.encryptString(plaintext).toString('base64')
      } catch {
        return null
      }
    },
    open(sealed) {
      if (!available) return null
      try {
        return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      } catch {
        // Written by another OS user, another machine, or a keychain that has
        // since been reset. Unrecoverable, and not worth an error: the caller
        // treats it as "no saved password".
        return null
      }
    },
  }
}
