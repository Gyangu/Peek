import type { PackageViewKindName } from '@peek/core'
import type { PlainMessageKey } from '../i18n'

/* ==================================================================
 * The window-side half of a view kind, by kind.
 *
 * Split from `register.ts` — which does the registering — because that module
 * imports `PackageFrame.tsx`, and a module that reaches React cannot be imported
 * by `node:test` (the runner strips types, it does not transform JSX). What is
 * worth testing here is the *table*: whether every contract the app carries has
 * a window-side entry, and whether the ids it names are servable. Keeping that
 * in a file with no React is what makes those assertions possible at all.
 * ================================================================== */

export interface PackageUiEntry {
  /**
   * The origin the frame loads from: `peek-package://<packageId>`.
   *
   * The package directory name minus `db-`, which is the same derivation
   * `scripts/build-packages.mjs` makes when it decides which directory a package
   * installs as. Two copies of one rule.
   */
  packageId: string
  titleKey: PlainMessageKey
}

/**
 * Every kind is Tier C today: an iframe on its own origin.
 *
 * Tier A — a declarative kind drawn by the host's own `DataGrid` — will have no
 * `packageId` at all, because its renderer is the host's rather than the
 * package's. When it lands, this becomes a union rather than a second table.
 */
export const PACKAGE_UI: Readonly<Record<PackageViewKindName, PackageUiEntry>> = {
  graph: { packageId: 'neo4j', titleKey: 'view.kind.graph' },
}
