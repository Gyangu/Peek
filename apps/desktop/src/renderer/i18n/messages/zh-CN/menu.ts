import type { CatalogFor } from '../../types'
import type { MenuMessages } from '../en/menu'

export const menu: CatalogFor<MenuMessages> = {
  'menu.cancel': '取消',

  'menu.tree.label': '对象操作',
  'menu.tree.open': '打开',
  'menu.tree.copyName': '复制名称',
  'menu.tree.refreshNode': '重新加载这一层',

  'menu.tab.label': '标签页操作',
  'menu.tab.close': '关闭标签页',
  'menu.tab.closeOthers': '关闭其他标签页',

  'menu.conn.label': '连接操作',
  'menu.session.label': '会话操作',

  /* ---------------- Second batch: the rest of the window ---------------- */

  'menu.error.label': '错误操作',
  'menu.error.copyEntry': '复制这一条',
  'menu.error.copyAll': '复制整个日志',
  'menu.error.clear': '清空日志',

  'menu.column.label': '列操作',
  'menu.column.sortAsc': '升序排列',
  'menu.column.sortDesc': '降序排列',
  'menu.column.sortClear': '取消排序',
  'menu.column.copyName': '复制列名',

  'menu.message.label': '消息操作',
  'menu.message.copy': '复制消息',

  'menu.tool.label': '工具调用操作',
  'menu.tool.copyInput': '复制参数',
  'menu.tool.copyOutput': '复制结果',

  'menu.chip.label': '附件操作',
  'menu.chip.copyLabel': '复制标签',
  'menu.chip.remove': '移除',

  'menu.kv.label': '条目操作',
  'menu.kv.copyKey': '复制键',
  'menu.kv.copyValue': '复制值',

  'menu.code.label': '代码操作',
  'menu.code.copy': '复制代码',

  'menu.divider.label': '分屏操作',
  'menu.divider.even': '均分',

  /* The one thing the right-click menu costs: it is invisible until tried. Said
     in the row's tooltip rather than as visible chrome — see the design record's
     §3.2, which takes the trade knowingly. */
  'menu.hint': '右键查看操作',
}
