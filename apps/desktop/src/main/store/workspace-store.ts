import { current, enablePatches, isDraft, produceWithPatches, type Draft, type Patch } from 'immer'
import {
  createEmptyWorkspace,
  snapshotWorkspace,
  type CommandName,
  type CommandSource,
  type Workspace,
  type WorkspaceReader,
  type WorkspaceSnapshot,
} from '@peek/core'

// immer 的 patch 插件必须显式开启，否则 produceWithPatches 拿不到 patch
enablePatches()

/* ================================================================== */
/* 变更元信息与订阅                                                      */
/* ================================================================== */

/** 一次状态变更的来源标注，patch 广播时原样带给 renderer */
export interface StoreChangeMeta {
  commandId?: string
  commandName?: CommandName
  source?: CommandSource
}

export interface StoreChange extends StoreChangeMeta {
  /** 变更前的 rev */
  fromRev: number
  /** 变更后的 rev */
  rev: number
  patches: Patch[]
  inversePatches: Patch[]
}

export type StoreListener = (change: StoreChange, state: Workspace) => void

export type WorkspaceRecipe<T> = (draft: Draft<Workspace>) => T

/* ================================================================== */
/* Workspace Store —— main 进程的唯一真源                                */
/* ================================================================== */

/**
 * PLAN 第 3/5 节：main 持真源，每次变更用 immer 产出 Patch[]，广播给 renderer 镜像。
 *
 * - `getState()` 给 main 内部（Connection Manager、driver host 事件回填）用，含明文口令。
 * - `getSnapshot()` 给 MCP 只读工具直接读（零 renderer 往返），已脱敏。
 * - 任何要离开 main 的东西一律走 sanitize.ts 的 redactWorkspace / redactPatches。
 */
export class WorkspaceStore implements WorkspaceReader {
  #state: Workspace
  readonly #listeners = new Set<StoreListener>()

  constructor(initial?: Workspace) {
    this.#state = initial ?? createEmptyWorkspace()
  }

  /** 真源本体（immer 已深冻结，外部拿到也改不动） */
  getState(): Workspace {
    return this.#state
  }

  /** 对外只读快照：config 已脱敏、view 已摊平（state.read 与 MCP read_workspace 都用它） */
  getSnapshot(): WorkspaceSnapshot {
    return snapshotWorkspace(this.#state)
  }

  get rev(): number {
    return this.#state.rev
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 落地一次纯状态变更。recipe 里抛异常 = 整次变更作废（immer 的 draft 直接丢弃），
   * 这保证了"命令要么整体生效要么完全不生效"。
   */
  apply(recipe: WorkspaceRecipe<void>, meta: StoreChangeMeta = {}): StoreChange {
    return this.applyWith(recipe, meta).change
  }

  /** 同 apply，但把 recipe 的返回值一并带出来（命令的纯状态阶段要返回结果数据） */
  applyWith<T>(recipe: WorkspaceRecipe<T>, meta: StoreChangeMeta = {}): { change: StoreChange; value: T } {
    const fromRev = this.#state.rev
    let value!: T
    const [next, patches, inversePatches] = produceWithPatches(this.#state, (draft) => {
      value = recipe(draft)
      // 每落地一条变更 rev +1；renderer 靠 rev 连续性检测漏包
      draft.rev += 1
    })

    this.#state = next
    const change: StoreChange = { ...meta, fromRev, rev: next.rev, patches, inversePatches }
    for (const listener of this.#listeners) {
      // 订阅者（patch 广播、日志）出问题不能反过来把命令搞失败：状态已经落地了
      try {
        listener(change, next)
      } catch (error) {
        console.error('[peek/store] patch 订阅者抛错', error)
      }
    }
    return { change, value }
  }
}

/* ================================================================== */
/* draft 工具                                                          */
/* ================================================================== */

/**
 * 把可能是 immer draft 的值转成普通对象。
 *
 * **必须用它**把 draft 上读到的数据带出 produce 之外（比如塞进副作用意图里）：
 * produce 结束后 draft 代理会被吊销，之后再访问会直接抛错。
 */
export function plain<T>(value: T): T {
  return isDraft(value) ? (current(value as Draft<T>) as T) : value
}
