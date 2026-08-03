import type { PluginViewKind } from '@peek/core'
import type { PlainMessageKey } from '../i18n'

/* ==================================================================
 * The window-side half of a view kind, by kind.
 *
 * Split from `register.ts` — which does the registering — because that module
 * imports `PluginFrame.tsx`, and a module that reaches React cannot be imported
 * by `node:test` (the runner strips types, it does not transform JSX). What is
 * worth testing here is the *table*: whether every contract the app carries has
 * a window-side entry, and whether the ids it names are servable. Keeping that
 * in a file with no React is what makes those assertions possible at all.
 * ================================================================== */

export interface PluginUiEntry {
  /**
   * The origin the frame loads from: `peek-plugin://<pluginId>`.
   *
   * The package directory name minus `driver-`, which is the same derivation
   * `scripts/build-plugin-ui.mjs` makes when it decides where to build. Two
   * copies of one rule, which is why `plugin-ui-entries.test.ts` checks they
   * agree rather than trusting that they do.
   */
  pluginId: string
  titleKey: PlainMessageKey
}

/**
 * Every kind is Tier C today: an iframe on its own origin.
 *
 * Tier A — a declarative kind drawn by the host's own `DataGrid` — will have no
 * `pluginId` at all, because its renderer is the host's rather than the
 * plugin's. When it lands, this becomes a union rather than a second table.
 */
export const PLUGIN_UI: Readonly<Record<PluginViewKind, PluginUiEntry>> = {
  graph: { pluginId: 'neo4j', titleKey: 'view.kind.graph' },
}
