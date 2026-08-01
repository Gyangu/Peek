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
  'sidebar.action.noQuery': '无查询语言',
  'sidebar.action.noQueryTitle': '{driverId} 没有语句接口，请用对象树浏览',

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
  'connect.invalid': '这不是一个有效的连接：{issue}',

  'connect.mode': '填写方式',
  'connect.mode.url': '连接串',
  'connect.mode.fields': '分项填写',

  'connect.field.url': '连接串',
  'connect.field.host': '主机',
  'connect.field.port': '端口',
  'connect.field.database': '数据库',
  'connect.field.user': '用户名',
  'connect.field.username': '用户名',
  'connect.field.password': '密码',
  'connect.field.ssl': '使用 TLS',
  'connect.field.tls': '使用 TLS',
  'connect.field.db': '库编号',
  'connect.field.file': '数据库文件',
  'connect.field.readOnly': '只读打开',
  'connect.field.qdrantUrl': '服务地址',
  'connect.field.apiKey': 'API Key',
}
