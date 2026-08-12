/**
 * @peek/core — the frozen shared contract.
 *
 * No business logic lives here, only:
 *   messages.ts       message-formatting primitives (interpolation, plurals)
 *   error-messages.ts canonical English catalog for peek-authored errors
 *   errors.ts         structured errors
 *   ids.ts            branded types and id generation
 *   chunk.ts          columnar result-stream protocol + performance-budget constants
 *   values.ts         canonical JS representation of a cell, per LogicalType
 *   cursor.ts         continuation-cursor semantics (page boundary + intra-page skip)
 *   capability.ts     driver capability model (Driver / DriverSession / Cursor / the Refs)
 *   manifest.ts       DriverManifest: what a database *is* (name, capabilities, connect form),
 *                     declared by each driver package in a client-free subpath entry
 *   package-manifest.ts  the same declarations as a file: `peek-package.json`, its schema,
 *                     and the parse whose failures the loader shows the user.
 *                     **Types only through this barrel** — the schema and the parse are
 *                     `@peek/core/package-manifest`, see the export below
 *   view-kinds.ts     the contract half of a package-contributed view kind
 *   mcp-tools.ts      the shape an MCP tool is declared in, so a package can contribute one
 *   package-view-channel.ts the one MessagePort protocol a self-drawn (Tier C) package view speaks
 *   driver-host.ts    driver-agnostic driver-host runtime (the ipc.ts protocol, implemented once)
 *   package-host.ts   the package-host protocol and the runtime that speaks it from inside the process
 *   workspace.ts      Workspace state model (tiled layout / views / connection state machine)
 *   layout-dnd.ts     drop-zone geometry for dragging a view between panels
 *   commands.ts       Command Bus contract (zod schemas and TS types from one source)
 *   ipc.ts            inter-process protocol (main ↔ renderer ↔ driver host)
 *
 * Every cross-module type is imported from here; never reach into '@peek/core/src/...'.
 */

export * from './messages'
export * from './error-messages'
export * from './errors'
export * from './untrusted-text'
export * from './ids'
export * from './chunk'
export * from './values'
export * from './capability'
export * from './manifest'
/*
 * The one module this barrel exports **types from and nothing else**.
 *
 * `packageToolInputSchema` calls `z.fromJSONSchema`, and only main ever does:
 * a package declares its tool arguments as JSON Schema on disk, and turning
 * that back into a validator is the loader's job. The window neither loads
 * packages nor validates tool arguments — it is handed `InstalledPackages`
 * already parsed.
 *
 * `export *` put it in the window anyway, and the price was measured rather
 * than guessed (design 2026-08-07 §4tervicies(c)): the renderer chunk carried
 * `zod/v4/classic/from-json-schema.js` and 28 KB of schema machinery around it,
 * ~36.7 KB in total for code that could not run there. Rollup was right to keep
 * it. Every schema in `package-manifest.ts` is a top-level `z.object(…)` call
 * and zod carries no pure annotation on its constructors, so the module is a
 * side effect and ships whole once anything reaches the barrel; and
 * `from-json-schema.js` opens with `{..._schemas, ..._checks}` over namespace
 * imports, which retains every export of `classic/schemas.js` and
 * `classic/checks.js` — that is the 28 KB, and it is why one unused function
 * cost far more than its own bytes.
 *
 * `export type *` is erased before Rollup sees a graph, so the vocabulary stays
 * exactly where every other cross-module type is (`InstalledPackages` and its
 * three members are named all over the renderer), while the schema and the
 * parse are reachable only through `@peek/core/package-manifest`. Value imports
 * of them from this barrel stop compiling — TypeScript refuses a type-only
 * export used as a value — and `assertWindowHoldsNoMainOnlyCore` in
 * `apps/desktop/electron.vite.config.ts` fails the build if the module reaches
 * a renderer chunk by any other route.
 */
export type * from './package-manifest'
export * from './view-kinds'
export * from './mcp-tools'
export * from './package-view-channel'
export * from './cursor'
export * from './chat'
export * from './workspace'
export * from './layout-dnd'
export * from './commands'
export * from './ipc'
export * from './driver-host'
export * from './package-host'
