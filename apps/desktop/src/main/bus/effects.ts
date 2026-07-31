import type { CommandName, CommandSource, PeekErrorCode } from '@peek/core'
import { failResult, cancelResult, setConnectionStatus } from '../store/mutations'
import type { WorkspaceStore } from '../store/workspace-store'
import type { CommandDeps } from './deps'
import { CommandFailure, asPeekError } from './failure'
import type { EffectIntent } from './intents'

/**
 * 副作用执行阶段。
 *
 * 纯状态阶段登记的意图在这里按序执行，全部通过注入的 CommandDeps 走出去 ——
 * bus 不认识 Connection Manager，也不认识任何驱动。
 * 执行过程中产生的状态变化（连上了 / 失败了 / 取消成功）继续走 store.apply，
 * 于是 renderer 能看到 connecting → ready 的实时过渡。
 */

export interface EffectRunnerCtx {
  store: WorkspaceStore
  deps: CommandDeps
  commandId: string
  commandName: CommandName
  source: CommandSource
}

export async function runIntents(intents: readonly EffectIntent[], ctx: EffectRunnerCtx): Promise<void> {
  for (const intent of intents) {
    try {
      await runIntent(intent, ctx)
    } catch (raw) {
      const error = asPeekError(raw, fallbackCodeOf(intent))
      applyIntentFailure(intent, error, ctx)
      if (intent.soft === true) {
        ctx.deps.notify?.({
          level: 'warn',
          message: `${ctx.commandName} 的 ${intent.type} 未成功`,
          detail: error.message,
        })
        continue
      }
      throw new CommandFailure(error)
    }
  }
}

async function runIntent(intent: EffectIntent, ctx: EffectRunnerCtx): Promise<void> {
  const meta = { commandId: ctx.commandId, commandName: ctx.commandName, source: ctx.source }

  switch (intent.type) {
    case 'connect': {
      const outcome = await ctx.deps.connections.open({
        connId: intent.connId,
        config: intent.config,
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      })
      ctx.store.apply((draft) => {
        setConnectionStatus(draft, intent.connId, 'ready', {
          capabilities: outcome.capabilities,
          ...(outcome.serverInfo ? { serverInfo: outcome.serverInfo } : {}),
          ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
          readyAt: Date.now(),
        })
      }, meta)
      return
    }

    case 'disconnect':
      await ctx.deps.connections.close(intent.connId)
      return

    case 'runQuery':
      await ctx.deps.results.runQuery({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        text: intent.text,
        ...(intent.params ? { params: intent.params } : {}),
        ...(intent.maxRows !== undefined ? { maxRows: intent.maxRows } : {}),
        ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
      })
      return

    case 'scan':
      await ctx.deps.results.scanCollection({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        ref: intent.ref,
        ...(intent.filter ? { filter: intent.filter } : {}),
        ...(intent.sort ? { sort: intent.sort } : {}),
        ...(intent.offset !== undefined ? { offset: intent.offset } : {}),
        ...(intent.limit !== undefined ? { limit: intent.limit } : {}),
        ...(intent.cursorToken !== undefined ? { cursorToken: intent.cursorToken } : {}),
      })
      return

    case 'vectorSearch':
      await ctx.deps.results.vectorSearch({
        connId: intent.connId,
        viewId: intent.viewId,
        resultId: intent.resultId,
        collection: intent.collection,
        ...(intent.queryVec ? { queryVec: intent.queryVec } : {}),
        topK: intent.topK,
        ...(intent.filter ? { filter: intent.filter } : {}),
      })
      return

    case 'cancel': {
      const cancelled = await ctx.deps.results.cancel({ connId: intent.connId, resultId: intent.resultId })
      if (!cancelled) return
      ctx.store.apply((draft) => {
        cancelResult(draft, intent.resultId)
      }, meta)
      return
    }
  }
}

/** 副作用失败时把状态机推到 error，避免视图永远停在 loading */
function applyIntentFailure(
  intent: EffectIntent,
  error: ReturnType<typeof asPeekError>,
  ctx: EffectRunnerCtx,
): void {
  const meta = { commandId: ctx.commandId, commandName: ctx.commandName, source: ctx.source }

  switch (intent.type) {
    case 'connect':
      ctx.store.apply((draft) => {
        setConnectionStatus(draft, intent.connId, 'error', { error })
      }, meta)
      return
    case 'runQuery':
    case 'scan':
    case 'vectorSearch':
      ctx.store.apply((draft) => {
        failResult(draft, intent.resultId, error)
      }, meta)
      return
    case 'disconnect':
    case 'cancel':
      return
  }
}

function fallbackCodeOf(intent: EffectIntent): PeekErrorCode {
  switch (intent.type) {
    case 'connect':
      return 'CONNECTION_FAILED'
    case 'runQuery':
    case 'scan':
    case 'vectorSearch':
      return 'QUERY_FAILED'
    default:
      return 'INTERNAL'
  }
}
