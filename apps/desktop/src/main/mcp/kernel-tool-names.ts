/* ==================================================================
 * The names the kernel's own tools occupy, as a value main can compare against.
 *
 * `collectBuiltinTools()` is the source of truth for *what* those tools are, but
 * it is built on `import.meta.glob` — a Vite construct that exists only inside a
 * bundle — and it evaluates every tool module, which drags the executor and the
 * bus in with it. The loader needs the names alone, during a scan, before any of
 * that exists; so the names live here, in a module that imports nothing.
 *
 * Two lists that must agree is exactly the failure this file could introduce, so
 * it does not get to drift: `mcp/__tests__/kernel-tool-names.test.ts` imports
 * every module under `tools/` and asserts this array is precisely the set of
 * names they declare. Adding a tool file without adding it here is a red test,
 * not a package that quietly gets to shadow it.
 * ================================================================== */

/**
 * Sorted, and frozen, because it is a fact about this build rather than a list
 * anyone edits at runtime.
 */
export const KERNEL_TOOL_NAMES: readonly string[] = Object.freeze([
  'activate_view',
  'ask',
  'cancel_query',
  'connect',
  'control_chat',
  'introspect',
  'list_connections',
  'move_view',
  'notify',
  'open_view',
  'read_chat',
  'read_workspace',
  'run_query',
  'send_chat',
  'set_layout',
  'set_ratio',
])

const LOOKUP: ReadonlySet<string> = new Set(KERNEL_TOOL_NAMES)

/** Whether `tools/list` would already carry this name without any package installed. */
export function isKernelToolName(name: string): boolean {
  return LOOKUP.has(name)
}
