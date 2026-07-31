import type { CatalogFor } from '../../types'
import type { SidebarMessages } from '../en/sidebar'

export const sidebar: CatalogFor<SidebarMessages> = {
  'sidebar.connections': '连接',
  'sidebar.newConnection': '新建连接',
  'sidebar.empty': '还没有连接',
  'sidebar.emptyHint': '点右上角 ＋ 新建',

  'sidebar.action.tree': '对象树',
  'sidebar.action.query': '查询',
  'sidebar.action.disconnect': '断开',

  'sidebar.status.idle': '未连接',
  'sidebar.status.connecting': '连接中…',
  'sidebar.status.ready': '已连接',
  'sidebar.status.error': '连接失败',

  'connect.title': '新建连接',
  'connect.driver': '驱动',
  'connect.capabilities': '能力：{list}',
  'connect.label': '显示名',
  'connect.labelPlaceholder': '留空则自动生成',
  'connect.privacyNote': '连接串里的密码只存在 main 进程；发回界面的配置一律脱敏。',
  'connect.cancel': '取消',
  'connect.submit': '连接',
  'connect.connecting': '连接中…',

  'connect.field.postgres': '连接串',
  'connect.field.mysql': '连接串',
  'connect.field.sqlite': '文件路径',
  'connect.field.redis': '连接串',
  'connect.field.qdrant': '服务地址',
}
