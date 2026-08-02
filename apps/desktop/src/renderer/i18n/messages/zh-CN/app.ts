import type { CatalogFor } from '../../types'
import type { AppMessages } from '../en/app'

export const app: CatalogFor<AppMessages> = {
  'app.bridgeNotReady': 'preload 桥未就绪',
  'app.syncing': '同步状态中…',

  'app.toast.dismiss': '关闭',

  'app.command.notSent': '命令未发出',
  'app.command.bridgeUnavailable': 'preload 桥不可用，无法与 main 通信',
  'app.command.threw': '命令 {name} 执行异常',

  'app.notify.resync': '状态重新对齐',
  'app.notify.snapshotFailed': '读取状态快照失败',
  'app.notify.bridgeMissingDetail': '窗口以只读演示态运行；请确认 preload/index.cjs 已构建并挂载。',

  'app.error.position': '位置 {position}',
  'app.error.prefixed': '{context}：{message}',

  'app.crash.title': '窗口渲染中断',
  'app.crash.body': '重新加载会依据主进程中的状态重建窗口；连接保持不变，不会丢失任何内容。',
  'app.crash.reload': '重新加载窗口',

  /* ---- 错误中心 ---- */
  'app.errors.title': '错误日志',
  'app.errors.count': { other: '{count} 条错误' },
  'app.errors.unseen': { other: '{count} 条新错误' },
  'app.errors.openTitle': '查看最近的失败记录，含错误码与详情',
  'app.errors.empty': '还没有出现过失败',
  'app.errors.copyAll': '复制全部',
  'app.errors.copyEntry': '复制',
  'app.errors.copied': '已复制',
  'app.errors.clear': '清空',
  'app.errors.close': '关闭',
  'app.errors.sourceTitle':
    '出问题的那件事是谁要求的。“你”是本窗口；“MCP”是外部客户端；“对话”是 peek 自己的聊天面板；' +
    '“peek”是应用自身——驱动进程、超时、状态同步。',
  'app.errors.source.ui': '你',
  'app.errors.source.mcp': 'MCP',
  'app.errors.source.agent': '对话',
  'app.errors.source.system': 'peek',
  'app.errors.dataPlaneDown': 'peek 启动了，但数据通道没建立——查询永远不会返回数据',
  'app.errors.dataPlaneDownDetail':
    '连接、浏览和设置仍然可用，它们走的是另一条通道。请重启 peek；如果重复出现，这是一个值得上报的 bug。',
}
