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

  'app.language.title': '界面语言',

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
    '这条失败从哪来。“你”表示本窗口发出的命令；“peek”表示应用自身（驱动进程、状态同步）。' +
    '“助手”表示本窗口没发出过任何请求它却出现了——通常是 MCP 工具调用——这是推断出来的，不是上报的。',
  'app.errors.source.ui': '你',
  'app.errors.source.mcp': '助手',
  'app.errors.source.system': 'peek',
}
