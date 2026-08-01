import type { CatalogFor } from '../../types'
import type { ContextMessages } from '../en/context'

/**
 * 「把正在看的数据加入对话」的中文文案。
 *
 * 免责声明那几条刻意写得直白：用户看的是生产库，把行发出去这件事必须一眼看懂，
 * 不能用「可能会共享部分信息」这种读完仍不知道发生了什么的说法。
 */
export const context: CatalogFor<ContextMessages> = {
  /* ---- 菜单 -------------------------------------------------------- */
  'context.menu.title': '加入对话',
  'context.menu.empty': '这里没有可以加入对话的内容',
  'context.menu.noChat': '请先打开一个对话面板',
  'context.menu.noChatTitle': '附件需要有地方可去：先打开一个对话视图，再试一次。',

  'context.attach.rows': { other: '加入选中的 {count} 行' },
  'context.attach.rowsTitle': '只发送表格中高亮的那几行',
  'context.attach.result': '加入本次结果（前 {count} 行）',
  'context.attach.resultTitle':
    '发送的是消息发出那一刻的结果——先改 SQL 重跑，发出去的就是新数据',
  'context.attach.cell': '加入单元格 {column}（第 {row} 行）',
  'context.attach.cellTitle': '发送完整值，而不是表格里显示的预览',
  'context.attach.schema': '加入 {name} 的表结构',
  'context.attach.schemaTitle': '列定义、类型、主键与索引',
  'context.attach.query': '加入查询语句',
  'context.attach.queryTitle': '发送消息时编辑器里是什么，就发送什么',
  'context.attach.workspace': '加入当前界面状态',
  'context.attach.workspaceTitle': '布局，以及每个已打开视图的一行说明。绝不包含连接凭据。',

  /* ---- 浮动按钮 ---------------------------------------------------- */
  'context.float.add': { other: '把 {count} 行加入对话' },
  'context.float.clear': '取消选择',
  'context.float.spanWarning':
    '这些行相距 {span} 行。peek 不会为了取其中 {count} 行而读取这么大的范围——请选择相邻的行，或直接加入整个结果。',

  /* ---- 附件区 ------------------------------------------------------ */
  'context.chips.heading': { other: '{count} 个附件' },
  'context.chips.remove': '移除 {label}',
  'context.chips.pending': '将在发送时采集',
  'context.chips.truncatedRows': '共 {total} 行，只取前 {included} 行',
  'context.chips.truncatedRowsUnknown': '只取前 {included} 行',
  'context.chips.truncatedChars': '共 {total} 字符，只取前 {included} 个',
  'context.chips.omitted': '本条消息装不下',
  'context.chips.sourceIncomplete': '结果本身就不完整',
  'context.chips.failed': '不可用',

  /* ---- 首次提示 ---------------------------------------------------- */
  'context.consent.title': '这些数据会被发送给 Anthropic',
  'context.consent.body':
    '把数据行、字段值、查询语句或表结构加入对话，意味着它们会作为消息的一部分发送到 Anthropic 的 API，供 Claude 阅读。它们会离开这台机器。',
  'context.consent.scope':
    '只有你主动添加的内容会被发送。peek 绝不会包含连接凭据——不含密码、API key、主机地址或用户名。',
  'context.consent.production':
    '请把它当作「把同样这些行粘贴到一个外部服务」来看待。如果这个连接里有个人信息或受监管数据，请先确认这样做是被允许的。',
  'context.consent.once': '这个提示只会出现一次。',
  'context.consent.accept': '我已了解，加入对话',
  'context.consent.cancel': '取消',

  /* ---- 提示 -------------------------------------------------------- */
  'context.added': '已把 {label} 加入对话',
  'context.addFailed': '无法把 {label} 加入对话',
  'context.removed': '已移除 {label}',
}
