import type { CatalogFor } from '../../types'
import type { PanelMessages } from '../en/panel'

export const panel: CatalogFor<PanelMessages> = {
  'panel.empty': '空面板',
  'panel.emptyWithConn': '空面板 · {label}',
  'panel.emptyHint': '先在左侧连接一个数据库',
  'panel.splitRow': '左右分屏',
  'panel.splitCol': '上下分屏',
  'panel.closeView': '关闭视图',
  'panel.closePanel': '关闭面板',
  'panel.newQuery': '新建查询',
  'panel.objectTree': '对象树',

  'panel.tabs.listLabel': '面板标签页',
  'panel.tab.close': '关闭 {title}',

  'panel.dragView': '拖拽以移动此视图',
  'panel.drop.move': '移动到此处',
  'panel.drop.stack': '作为标签页加入 {title}',
  'panel.drop.tab': '插入到此处',
  'panel.drop.split.left': '向左分屏',
  'panel.drop.split.right': '向右分屏',
  'panel.drop.split.top': '向上分屏',
  'panel.drop.split.bottom': '向下分屏',

  'a11y.panel.label': '面板 {index}：{title}',
  'a11y.panel.empty': '空面板 {index}',

  'view.gone': '视图 {viewId} 已不存在',

  'view.kind.table': '表格',
  'view.kind.query': '查询',
  'view.kind.inspector': '检查器',
  'view.kind.tree': '对象树',
  'view.kind.vector': '向量检索',
  'view.kind.chat': '对话',

  'view.describe.table': '{kind} {ref} · 偏移 {offset} 限制 {limit}',
  'view.describe.query': '{kind} {text}',
  'view.describe.inspector': '{kind} {ref}',
  'view.describe.tree': { other: '{kind} · 已展开 {count} 个节点' },
  'view.describe.vector': '{kind} {collection} · topK {topK}',
  'view.describe.chat': { other: '{kind} · {count} 条消息' },

  'panel.newChat': '新建对话',
}
