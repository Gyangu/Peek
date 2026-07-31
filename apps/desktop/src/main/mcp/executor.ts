/**
 * 通用工具执行器：校验 → 依次 dispatch 到 Command Bus → 汇总结果 → 转 MCP 返回格式。
 *
 * 所有工具共用这一条路径，工具文件里只剩 schema + 映射，没有流程代码。
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
import type {
  CommandOutcome,
  CommandToolSpec,
  PeekTool,
  ReadToolSpec,
  ToolContext,
  ToolOutput,
} from './types'

/* ================================================================== */
/* 1. 单条 Command 的 dispatch                                          */
/* ================================================================== */

/**
 * 把 `Command` 这个可辨识联合安全地喂给泛型 dispatch。
 * 内层的泛型函数把 name 与 input 的相关性重新绑定，避免任何断言。
 */
export async function dispatchCommand(
  ctx: ToolContext,
  cmd: Command,
): Promise<CommandResult<unknown>> {
  const run = <K extends CommandName>(c: {
    name: K
    input: CommandInput<K>
  }): Promise<CommandResult<unknown>> => ctx.dispatch(c.name, c.input, 'mcp')
  return run(cmd)
}

/* ================================================================== */
/* 2. 默认渲染                                                          */
/* ================================================================== */

function defaultRender(outcomes: CommandOutcome[], ctx: ToolContext): ToolOutput {
  const failed = outcomes.find((o) => !o.ok)
  const snap = ctx.getSnapshot()
  const head = failed
    ? `命令 ${failed.name} 失败：${failed.error?.code ?? 'INTERNAL'} ${failed.error?.message ?? ''}`
    : `已执行 ${outcomes.length} 条命令，workspace rev=${snap.rev}`
  const body = toJson(outcomes)
  return {
    text: `${head}\n\n${body}\n\n当前面板：\n${renderPanelBrief(snap)}`,
    ...(failed ? { isError: true } : {}),
  }
}

/** 工具级错误的统一形状：结构化 PeekError，绝不抛出去让 server 崩 */
export function errorOutput(error: PeekError): ToolOutput {
  return {
    text: `[${error.code}] ${error.message}${error.detail ? `\n${error.detail}` : ''}`,
    data: error,
    isError: true,
  }
}

/* ================================================================== */
/* 3. defineTool：把带泛型的 spec 擦成统一的 PeekTool                      */
/* ================================================================== */

function baseFields<S extends z.ZodType>(
  spec: CommandToolSpec<S> | ReadToolSpec<S>,
): Pick<PeekTool, 'name' | 'title' | 'description' | 'inputSchema' | 'annotations'> {
  return {
    name: spec.name,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
  }
}

/** 入参校验：失败一律 BAD_REQUEST，带上 zod 的路径信息 */
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
    error: peekError('BAD_REQUEST', `工具 ${spec.name} 入参不合法`, { detail }),
  }
}

/** 映射到 Command 的工具 */
export function defineCommandTool<S extends z.ZodType>(spec: CommandToolSpec<S>): PeekTool {
  return {
    ...baseFields(spec),
    readOnly: spec.annotations?.readOnlyHint === true,
    async run(rawInput, ctx) {
      const parsed = parseInput(spec, rawInput)
      if (!parsed.ok) return errorOutput(parsed.error)

      let commands: Command[]
      try {
        commands = await spec.toCommands(parsed.value, ctx)
      } catch (err) {
        return errorOutput(toPeekError(err))
      }

      const outcomes: CommandOutcome[] = []
      for (const cmd of commands) {
        // 二次校验：工具映射出的入参也必须过 Command 的 schema，
        // 保证进 Command Bus 的一定合法（PLAN 第 6 节）
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
      if (spec.render && !anyFailed) {
        try {
          return await spec.render(outcomes, parsed.value, ctx)
        } catch (err) {
          return errorOutput(toPeekError(err))
        }
      }
      return defaultRender(outcomes, ctx)
    },
  }
}

/** 只读工具：直接读 Workspace Store，不经 dispatch */
export function defineReadTool<S extends z.ZodType>(spec: ReadToolSpec<S>): PeekTool {
  return {
    ...baseFields(spec),
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

/* ================================================================== */
/* 4. 取某条命令的返回数据（工具自定义 render 时用）                        */
/* ================================================================== */

/** 从 outcomes 里挑出第一条成功执行的指定命令的返回数据 */
export function outcomeData(outcomes: readonly CommandOutcome[], name: CommandName): unknown {
  return outcomes.find((o) => o.name === name && o.ok)?.data
}
