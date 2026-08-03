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
 *   view-kinds.ts     the contract half of a plugin-contributed view kind
 *   mcp-tools.ts      the shape an MCP tool is declared in, so a package can contribute one
 *   plugin-channel.ts the one MessagePort protocol a self-drawn (Tier C) plugin view speaks
 *   driver-host.ts    driver-agnostic driver-host runtime (the ipc.ts protocol, implemented once)
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
export * from './view-kinds'
export * from './mcp-tools'
export * from './plugin-channel'
export * from './cursor'
export * from './chat'
export * from './workspace'
export * from './layout-dnd'
export * from './commands'
export * from './ipc'
export * from './driver-host'
