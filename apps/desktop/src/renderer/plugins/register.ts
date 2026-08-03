import { createElement } from 'react'
import type { PluginViewState } from '@peek/core'
import { VIEW_KIND_CONTRACTS } from '../../drivers/viewKinds'
import { notify } from '../state/notifyStore'
import { PluginFrame } from './PluginFrame'
import { PLUGIN_UI } from './uiEntries'
import { registerViewKind } from './viewKinds'

/* ==================================================================
 * Attach the window's half to every view-kind contract the app carries.
 *
 * `drivers/viewKinds.ts` holds the half both processes can share — describe,
 * title, autoFetch, collectionRef, all pure. This file adds the two things that
 * are the window's alone: which message key names the kind, and what draws it.
 *
 * ## Why the contracts are iterated rather than listed again
 *
 * A second hand-written list is a second thing to forget. Iterating the shared
 * one means a package that contributes a contract and no UI entry is a **loud
 * refusal at startup** rather than a view kind that opens into a blank panel —
 * which is the same trade `registerViewKind` makes for a missing `autoFetch`,
 * and the compensation for the compile-time exhaustiveness a plugin kind cannot
 * have (`core/view-kinds.ts`).
 *
 * The table itself is `./uiEntries`, which is a separate module for one reason:
 * this one imports `PluginFrame.tsx`, and a module that reaches React cannot be
 * imported by `node:test`. The half worth asserting — does every contract have a
 * window-side entry — is therefore the half that had to stay reachable.
 * ================================================================== */

/**
 * Register every contract, and report the ones that could not be registered.
 *
 * Returns the refusals rather than throwing: one bad plugin must not stop the
 * others from loading, and the useful report is the whole list. The caller —
 * `main.tsx` — is what decides that a refusal is worth a toast.
 */
export function registerPluginViewKinds(): string[] {
  const problems: string[] = []
  for (const contract of VIEW_KIND_CONTRACTS) {
    const ui = PLUGIN_UI[contract.kind]
    if (ui === undefined) {
      problems.push(`view kind "${contract.kind}" has a contract but no window-side entry`)
      continue
    }
    const outcome = registerViewKind({
      contract,
      titleKey: ui.titleKey,
      render: (view: PluginViewState) =>
        // `createElement` rather than JSX so this file stays `.ts`: it is
        // imported by nothing that renders, and a `.tsx` here would pull the
        // whole registry into the JSX transform for one call.
        createElement(PluginFrame, { view, pluginId: ui.pluginId, key: view.id }),
    })
    if (!outcome.ok && outcome.reason !== undefined) problems.push(outcome.reason)
  }
  return problems
}

/**
 * The startup call. Separate from the function above so that tests can register
 * into a clean registry without a toast reaching a store they do not have.
 */
export function startPlugins(): void {
  for (const problem of registerPluginViewKinds()) {
    // English, and to the error centre: this is a packaging fault in peek's own
    // build, not something a user can act on in their own language.
    notify('error', 'A plugin view kind could not be registered', problem)
  }
}
