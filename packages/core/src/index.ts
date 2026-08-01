/**
 * @peek/core — the frozen shared contract.
 *
 * No business logic lives here, only:
 *   messages.ts       message-formatting primitives (interpolation, plurals)
 *   error-messages.ts canonical English catalog for peek-authored errors
 *   errors.ts         structured errors
 *   ids.ts            branded types and id generation
 *   chunk.ts          columnar result-stream protocol + performance-budget constants
 *   capability.ts     driver capability model (Driver / DriverSession / Cursor / the Refs)
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
export * from './ids'
export * from './chunk'
export * from './capability'
export * from './workspace'
export * from './layout-dnd'
export * from './commands'
export * from './ipc'
export * from './driver-host'
