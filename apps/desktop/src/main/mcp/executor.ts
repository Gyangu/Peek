/**
 * The shared tool executor: validate → dispatch to the Command Bus in order → aggregate
 * outcomes → convert to the MCP return format.
 *
 * Every tool travels this one path, which is why tool files contain nothing but a schema and
 * a mapping — no control flow.
 */

import type { z } from 'zod'
import {
  parseCommandInput,
  peekError,
  toPeekError,
  type Command,
  type CommandInput,
  type CommandName,
  type CommandResult,
  type PeekError,
} from '@peek/core'
import { renderPanelBrief, toJson } from './summary'
import { diffUiEffects, renderUiEffects, type UiEffect } from './ui-effects'
import type {
  CommandOutcome,
  CommandToolSpec,
  PeekTool,
  ReadToolSpec,
  ToolContext,
  ToolOutput,
  ToolSpec,
} from './types'

/* ================================================================== */
/* 1. Dispatching a single Command                                      */
/* ================================================================== */

/**
 * Feed the `Command` discriminated union into the generic dispatch safely.
 * The inner generic function re-binds the correlation between `name` and `input`, which keeps
 * the whole path free of type assertions.
 */
export async function dispatchCommand(
  ctx: ToolContext,
  cmd: Command,
): Promise<CommandResult<unknown>> {
  const run = <K extends CommandName>(c: {
    name: K
    input: CommandInput<K>
  }): Promise<CommandResult<unknown>> => ctx.dispatch(c.name, c.input, ctx.source ?? 'mcp')
  return run(cmd)
}

/* ================================================================== */
/* 2. Default rendering                                                 */
/* ================================================================== */

function defaultRender(outcomes: CommandOutcome[], ctx: ToolContext): ToolOutput {
  const failed = outcomes.find((o) => !o.ok)
  const snap = ctx.getSnapshot()
  const head = failed
    ? `Command ${failed.name} failed: ${failed.error?.code ?? 'INTERNAL'} ${failed.error?.message ?? ''}`
    : `Executed ${outcomes.length} command(s), workspace rev=${snap.rev}`
  const body = toJson(outcomes)
  return {
    text: `${head}\n\n${body}\n\nCurrent panels:\n${renderPanelBrief(snap)}`,
    ...(failed ? { isError: true } : {}),
  }
}

/**
 * Attach the window diff to a receipt.
 *
 * Applied by the executor to **every** command tool, after that tool's own
 * renderer has run, so a tool cannot opt out and cannot describe the window
 * differently from what the window did. An unchanged window still says so
 * explicitly: silence would leave a model unable to tell "nothing happened" from
 * "this tool does not report".
 */
function withUiEffects(out: ToolOutput, effects: UiEffect[]): ToolOutput {
  return {
    ...out,
    text: `${out.text}\n\n${renderUiEffects(effects)}`,
    ...(effects.length === 0 ? {} : { uiEffects: effects }),
  }
}

/** The uniform shape of a tool-level error: a structured PeekError, never thrown out to crash the server. */
export function errorOutput(error: PeekError): ToolOutput {
  return {
    text: `[${error.code}] ${error.message}${error.detail ? `\n${error.detail}` : ''}`,
    data: error,
    isError: true,
  }
}

/* ================================================================== */
/* 3. defineTool: erase the generic spec down to a uniform PeekTool     */
/* ================================================================== */

/**
 * Everything a tool declares except its description.
 *
 * `description` is left out and re-declared as a **getter** by each caller
 * below, and the omission is the whole point: two of the kernel's tools build
 * their description out of the installed packages (`connect` lists a config
 * example per driver, `list_connections` names one in its empty state), and
 * every tool module is evaluated when `collectBuiltinTools`' eager glob is
 * imported — which is while main is still loading, before anything has read
 * `~/.peek/packages/`. A copied string would be the string those two had at
 * that moment, which is empty. Spreading the result of this function is what
 * would flatten a getter back into one, so it does not travel through here.
 *
 * The cost is that a lazy description is recomputed per read. It is read once
 * per MCP session, when the tools are registered on a fresh `McpServer`.
 */
function baseFields<S extends z.ZodType>(
  spec: CommandToolSpec<S> | ReadToolSpec<S>,
): Pick<PeekTool, 'name' | 'title' | 'inputSchema' | 'annotations'> {
  return {
    name: spec.name,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    inputSchema: spec.inputSchema,
    ...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
  }
}

/** Input validation: every failure becomes BAD_REQUEST, carrying zod's path information. */
function parseInput<S extends z.ZodType>(
  spec: { name: string; inputSchema: S },
  raw: unknown,
): { ok: true; value: z.output<S> } | { ok: false; error: PeekError } {
  const parsed = spec.inputSchema.safeParse(raw ?? {})
  if (parsed.success) return { ok: true, value: parsed.data }
  const detail = parsed.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n')
  return {
    ok: false,
    error: peekError('BAD_REQUEST', `Invalid input for tool ${spec.name}`, { detail }),
  }
}

/** A tool that maps onto Commands. */
export function defineCommandTool<S extends z.ZodType>(spec: CommandToolSpec<S>): PeekTool {
  return {
    ...baseFields(spec),
    // Declared here rather than inside `baseFields`, because a spread reads a
    // getter and stores the value it returned. See that function.
    get description() {
      return spec.description
    },
    readOnly: spec.annotations?.readOnlyHint === true,
    async run(rawInput, ctx) {
      const parsed = parseInput(spec, rawInput)
      if (!parsed.ok) return errorOutput(parsed.error)

      // Taken before anything is dispatched, so the diff covers the whole call —
      // including the changes a later command in the sequence made, and including
      // the ones this tool never meant to make.
      const before = ctx.getSnapshot()

      let commands: Command[]
      try {
        commands = await spec.toCommands(parsed.value, ctx)
      } catch (err) {
        return errorOutput(toPeekError(err))
      }

      const outcomes: CommandOutcome[] = []
      for (const cmd of commands) {
        // Second validation pass: input produced by the tool mapping must still satisfy the
        // Command's own schema, so nothing invalid can ever reach the Command Bus (PLAN section 6).
        const check = parseCommandInput(cmd.name, cmd.input)
        if (!check.ok) {
          outcomes.push({ name: cmd.name, ok: false, error: check.error })
          break
        }
        let res: CommandResult<unknown>
        try {
          res = await dispatchCommand(ctx, cmd)
        } catch (err) {
          outcomes.push({ name: cmd.name, ok: false, error: toPeekError(err) })
          break
        }
        if (res.ok) {
          outcomes.push({ name: cmd.name, ok: true, rev: res.rev, data: res.data })
        } else {
          outcomes.push({ name: cmd.name, ok: false, error: res.error })
          break
        }
      }

      const anyFailed = outcomes.some((o) => !o.ok)
      let out: ToolOutput
      if (spec.render && !anyFailed) {
        try {
          out = await spec.render(outcomes, parsed.value, ctx)
        } catch (err) {
          // A renderer that throws still leaves the window changed, so the diff
          // is reported anyway — the caller needs to know what landed before the
          // receipt fell over.
          return withUiEffects(errorOutput(toPeekError(err)), diffUiEffects(before, ctx.getSnapshot()))
        }
      } else {
        out = defaultRender(outcomes, ctx)
      }
      // Deliberately computed after the renderer: `open_view` waits for its result
      // set inside `render`, and a diff taken earlier would miss the rows that
      // arrived while it waited.
      return withUiEffects(out, diffUiEffects(before, ctx.getSnapshot()))
    },
  }
}

/** Read-only tool: reads the Workspace Store directly, never dispatches. */
export function defineReadTool<S extends z.ZodType>(spec: ReadToolSpec<S>): PeekTool {
  return {
    ...baseFields(spec),
    get description() {
      return spec.description
    },
    annotations: { readOnlyHint: true, ...spec.annotations },
    readOnly: true,
    async run(rawInput, ctx) {
      const parsed = parseInput(spec, rawInput)
      if (!parsed.ok) return errorOutput(parsed.error)
      try {
        return await spec.read(parsed.value, ctx)
      } catch (err) {
        return errorOutput(toPeekError(err))
      }
    },
  }
}

/**
 * A declared spec → a runnable tool, dispatching on the spec's own `kind`.
 *
 * This is the door a **package's** tool comes through, and it is deliberately
 * the same two functions above rather than a parallel path. Everything a tool
 * gets for free lives in them: the second validation pass that stops a mapped
 * input from reaching the Command Bus unchecked, the `uiEffects` block the
 * executor attaches so a tool can neither forget nor misreport what it did to
 * the window, and the catch that turns an escaped exception into a structured
 * error instead of a dead server. A package that built its own `PeekTool` would
 * have none of it, which is why `@peek/core` exports the *spec* type and not
 * these constructors (see `core/mcp-tools.ts`).
 *
 * The kernel's fourteen tools call `defineCommandTool` / `defineReadTool`
 * directly at their own module scope; this exists for the tools that arrive as
 * data, from a list, with no module of their own to call from.
 */
export function toPeekTool(spec: ToolSpec): PeekTool {
  return spec.kind === 'command' ? defineCommandTool(spec) : defineReadTool(spec)
}

/* ================================================================== */
/* 4. Pulling data back out of an outcome (used by custom renderers)    */
/* ================================================================== */

/** Pick the data returned by the first successful outcome for the named command. */
export function outcomeData(outcomes: readonly CommandOutcome[], name: CommandName): unknown {
  return outcomes.find((o) => o.name === name && o.ok)?.data
}
