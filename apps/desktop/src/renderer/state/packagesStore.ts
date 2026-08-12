import { create } from 'zustand'

/* ==================================================================
 * What makes the window notice that a package came or went.
 *
 * `drivers/installed.ts` is a slot, not a store: it is read synchronously from
 * places that have nowhere to put a subscription — a connect form's field list,
 * the capability prediction behind a greyed-out button, the package registration
 * that runs before the first paint. That shape was right when the registry was
 * filled once, before React existed, and never again (`main.tsx`).
 *
 * Design §2.7 makes it change while the window is open, and a slot alone cannot
 * express that: nothing re-renders on a module variable. So this is the counter
 * that turns "the registry was replaced" into a React update, and the registry
 * itself stays exactly where every synchronous reader already looks.
 *
 * ## Why a counter and not the registry
 *
 * Holding `InstalledPackages` here would make two copies of one truth, and the
 * synchronous readers cannot be moved onto this one (that is the paragraph
 * above). A counter says only "read again" — which is all a component that
 * already knows how to read the registry needs, and it cannot drift from what
 * that registry says.
 *
 * ## Why the counter is here and the adoption is not
 *
 * Replacing the registry means reconciling the package view kinds with it, and
 * that reaches `PackageFrame.tsx` — React, which `node --test` cannot load. This
 * module is imported by the renderer's plain-state modules, so it holds the half
 * that is only zustand; `packages/register.ts` owns the other half and calls
 * `packagesReplaced` when it is done.
 * ================================================================== */

interface PackagesState {
  /**
   * Bumped every time the installed registry is replaced.
   *
   * Starts at 0, which is the value it holds for the whole of a session in which
   * nothing is installed or uninstalled — the overwhelmingly common one.
   */
  revision: number
}

export const usePackagesStore = create<PackagesState>(() => ({ revision: 0 }))

/**
 * The registry has been replaced and the view kinds reconciled with it — redraw.
 *
 * Called **last**, by `packages/register.ts`, so a component woken by it never
 * sees a half-applied change: a driver whose package is gone, or a view kind
 * registered for a package that is not in the list yet.
 */
export function packagesReplaced(): void {
  usePackagesStore.setState((state) => ({ revision: state.revision + 1 }))
}

/**
 * Subscribe to "what is installed changed".
 *
 * For components that read the registry during render — the connect dialog's
 * driver picker, the settings panel's package table. They keep reading it the
 * synchronous way; this is only what makes them read it again.
 */
export function usePackagesRevision(): number {
  return usePackagesStore((state) => state.revision)
}
