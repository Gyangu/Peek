/**
 * @peek/core —— 冻结共享契约。
 *
 * 这个包不含任何业务逻辑，只有：
 *   errors.ts     结构化错误
 *   ids.ts        品牌类型与 id 生成
 *   chunk.ts      列式结果流协议 + 性能预算常量
 *   capability.ts 驱动能力模型（Driver / DriverSession / Cursor / 各种 Ref）
 *   workspace.ts  Workspace 状态模型（平铺布局 / 视图 / 连接状态机）
 *   commands.ts   Command Bus 契约（zod schema 与 TS 类型同源）
 *   ipc.ts        进程间协议（main ↔ renderer ↔ driver host）
 *
 * 所有跨模块的类型都从这里导入，不要深入 '@peek/core/src/...'。
 */

export * from './errors'
export * from './ids'
export * from './chunk'
export * from './capability'
export * from './workspace'
export * from './commands'
export * from './ipc'
