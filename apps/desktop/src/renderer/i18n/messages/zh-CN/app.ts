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

  'app.language.title': '界面语言',
}
