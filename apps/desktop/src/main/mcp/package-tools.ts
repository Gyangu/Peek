import {
  isCommandName,
  peekError,
  type Command,
  type CommandOutcome,
  type InstalledTool,
  type PackageToolAnswer,
  type PackageToolCall,
  type ToolOutput,
  type ToolSpec,
} from '@peek/core'
import { packageToolInputSchema } from '@peek/core/package-manifest'
import { installedTools } from '../../drivers/installed'
import { toPeekTool } from './executor'
import type { PeekTool } from './types'

/* ==================================================================
 * A package's tools, running where the package runs.
 *
 * ## The one thing that did not move
 *
 * `defineCommandTool`. A package tool is still built by the same constructor the
 * kernel's fourteen are built by, and that is the whole shape of this file: what
 * crosses the process boundary is the *mapping* — `toCommands`, `render`,
 * `read` — and everything wrapped around it stays here. The second validation
 * pass before a mapped input reaches the Command Bus, the `uiEffects` block the
 * executor attaches by diffing the window, and the catch that keeps one tool's
 * exception from taking the MCP server down are not features of the kernel's
 * tools; they are features of that function, and a package that ran its own copy
 * of the executor would silently have none of them.
 *
 * So each spec below is a *stand-in*: same name, same description, same
 * `inputSchema`, with the callbacks replaced by round trips. `toPeekTool` cannot
 * tell the difference, which is the point.
 *
 * ## Listing costs nothing; calling costs a process
 *
 * The declarative half never leaves main (§2.4bis(d)), so `tools/list` is
 * answered without waking anything — and with no `call` wired up at all, the
 * tools are still listed and only *calling* one fails. That asymmetry is
 * deliberate: a peek with no package hosts should describe its full tool surface
 * honestly rather than pretend a package was never installed.
 *
 * Which is why this module builds a stand-in from a declaration and never sees a
 * `ToolSpec` that a package wrote. Reading the declarations *off* the specs
 * would have been the same few lines and would have quietly re-linked every
 * mapping into main — the split is only worth anything if the process that must
 * not hold the code cannot name it. `drivers/mcpTools.ts` has the bundler-level
 * reason that makes "cannot name it" the operative phrase.
 *
 * ## Where the declarations come from, and why that is the whole of acceptance 13
 *
 * `installedTools()` — the loader's reading of `~/.peek/packages/`. Until
 * §4duodevicies this mapped `PACKAGE_TOOL_META`, a compile-time constant, and
 * the measurable consequence was the first sentence of acceptance 13 being
 * false: uninstalling neo4j left `expand_node` in `tools/list`, in that session,
 * in a fresh session, and across a restart with the package gone from disk. A
 * constant cannot describe what is installed, because installing is not a
 * compile-time event any more.
 *
 * Reading the registry is only half of it. The other half is in `server.ts`: a
 * live session registered its tools when it opened, so the list it answers with
 * has to be reconciled before `tools/list_changed` means anything
 * (`reconcileSessionTools` in `registry.ts`).
 *
 * ## What comes back is checked
 *
 * Main is the only sender on the way out, so the request needs no validation;
 * the answers are a package's code talking, and every one of them is inspected
 * here. See `checkOutput` in particular — a package returning its own
 * `uiEffects` is the one failure that would otherwise be invisible.
 * ================================================================== */

/**
 * How a tool call reaches the package that owns it.
 *
 * A function rather than the registry itself, so this module knows nothing about
 * forking, deadlines or process lifetime — and so the tests can answer a call
 * without a `utilityProcess`.
 */
export type PackageToolCaller = (packageId: string, call: PackageToolCall) => Promise<PackageToolAnswer>

/**
 * Every installed package's tools, as `PeekTool`s that run their mapping in the
 * owning host.
 *
 * Computed per call rather than once, because the registry it reads is replaced
 * by `packages.install` / `packages.uninstall` while the app is running. Every
 * caller is either opening an MCP session or reconciling one, both of which
 * happen at human speed.
 *
 * With no caller, each tool still lists and every call fails with a structured
 * error naming the reason.
 */
export function packageTools(call: PackageToolCaller | null): PeekTool[] {
  const tools: PeekTool[] = []
  for (const declared of installedTools()) {
    const spec = remoteSpec(declared, call)
    if (spec !== null) tools.push(toPeekTool(spec))
  }
  return tools
}

/* ================================================================== */
/* The stand-in spec                                                    */
/* ================================================================== */

/**
 * One declaration as a spec, or null when no validator can be built for it.
 *
 * The null is unreachable through the loader: `PackageManifestSchema` runs the
 * same conversion while it parses and refuses the package by name, so a
 * declaration that got this far has already been converted once. It is here
 * because the alternative to skipping is throwing, and this function runs while
 * an MCP session is being opened — one exotic schema would take the whole
 * endpoint down, kernel tools included, rather than cost the one tool that
 * cannot be called anyway.
 */
function remoteSpec(meta: InstalledTool, call: PackageToolCaller | null): ToolSpec | null {
  const { packageId } = meta
  const converted = packageToolInputSchema(meta.inputSchema)
  if (!converted.ok) return null

  const ask = async (params: PackageToolCall): Promise<PackageToolAnswer> => {
    if (call === null) {
      throw peekError(
        'INTERNAL',
        `Tool ${meta.name} belongs to package ${packageId}, and no package host is available to run it.`,
      )
    }
    return await call(packageId, params)
  }

  const base = {
    name: meta.name,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    description: meta.description,
    inputSchema: converted.schema,
    ...(meta.annotations === undefined ? {} : { annotations: meta.annotations }),
  }

  if (meta.kind === 'read') {
    return {
      ...base,
      kind: 'read',
      async read(input, ctx) {
        const answer = await ask({ name: meta.name, phase: 'read', args: input, snapshot: ctx.getSnapshot() })
        if (answer.phase !== 'read') throw wrongPhase(meta.name, 'read', answer)
        return checkOutput(answer.output, meta.name)
      },
    }
  }

  return {
    ...base,
    kind: 'command',
    async toCommands(input, ctx) {
      const answer = await ask({
        name: meta.name,
        phase: 'commands',
        args: input,
        snapshot: ctx.getSnapshot(),
      })
      if (answer.phase !== 'commands') throw wrongPhase(meta.name, 'commands', answer)
      return checkCommands(answer.commands, meta.name)
    },
    /*
     * Present exactly when the package declared one, because `defineCommandTool`
     * reads its absence as "use the default receipt" and there is no third answer
     * a stand-in could give. `hasRenderer` is the declaration saying so, and it is
     * a field rather than a `spec.render !== undefined` because main no longer has
     * the spec to look at — since §4duodevicies it is a key of `peek-package.json`,
     * the same as `description`. `toolFromMeta` in the host is what stops it
     * disagreeing with the mapping.
     */
    ...(meta.hasRenderer
      ? {
          async render(outcomes: CommandOutcome[], input, ctx): Promise<ToolOutput> {
            const answer = await ask({
              name: meta.name,
              phase: 'render',
              args: input,
              // Taken now, not reused from `toCommands`: the receipt describes a
              // window the commands have already changed, and a renderer handed
              // the earlier snapshot would describe the view as it was before its
              // own tool touched it.
              snapshot: ctx.getSnapshot(),
              outcomes,
            })
            if (answer.phase !== 'render') throw wrongPhase(meta.name, 'render', answer)
            if (answer.output === null) {
              throw peekError(
                'INTERNAL',
                `Tool ${meta.name} declares a renderer but package ${packageId} has none for it.`,
              )
            }
            return checkOutput(answer.output, meta.name)
          },
        }
      : {}),
  }
}

/* ================================================================== */
/* Checking the answers                                                 */
/* ================================================================== */

function wrongPhase(name: string, expected: string, answer: PackageToolAnswer): unknown {
  return peekError(
    'INTERNAL',
    `Tool ${name} answered a ${expected} request with a ${String(answer.phase)} result.`,
  )
}

/**
 * The commands a package's mapping produced.
 *
 * `parseCommandInput` in the executor validates each `input` a moment later, so
 * what is checked here is only what that call cannot survive: it looks the
 * schema up by name, and an unknown name would reach it as `undefined.safeParse`
 * — a TypeError where a BAD_REQUEST belongs. The names are typed `CommandName`
 * and this still checks them, because the type describes what a package
 * *promised*, not what it sent.
 */
function checkCommands(commands: readonly Command[], name: string): Command[] {
  if (!Array.isArray(commands)) {
    throw peekError('INTERNAL', `Tool ${name} did not return a list of Commands.`)
  }
  for (const cmd of commands) {
    if (typeof cmd !== 'object' || cmd === null || !isCommandName(cmd.name)) {
      throw peekError('INTERNAL', `Tool ${name} returned something that is not a Command.`)
    }
  }
  return [...commands]
}

/**
 * A `ToolOutput` a package built.
 *
 * `uiEffects` is dropped rather than rejected, and it is the reason this function
 * exists at all. The executor attaches the real diff with `withUiEffects`, which
 * spreads the tool's output first and only overwrites the field when the diff is
 * non-empty — so a package's own `uiEffects` would survive intact on exactly the
 * calls that changed nothing, and be reported to the model as things that
 * happened. Dropping it here restores the invariant `ToolOutput` states outright:
 * a tool cannot forget or misreport what it did to the window.
 */
function checkOutput(output: ToolOutput, name: string): ToolOutput {
  if (typeof output !== 'object' || output === null || typeof output.text !== 'string') {
    throw peekError('INTERNAL', `Tool ${name} returned no receipt text.`)
  }
  const { uiEffects: _ignored, ...rest } = output
  return rest
}
