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
 *   workspace.ts      Workspace state model (tiled layout / views / connection state machine)
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
export * from './commands'
export * from './ipc'
