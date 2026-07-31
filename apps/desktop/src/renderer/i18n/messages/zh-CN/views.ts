import type { CatalogFor } from '../../types'
import type { ViewsMessages } from '../en/views'

export const views: CatalogFor<ViewsMessages> = {
  'table.refresh': '刷新',
  'table.refreshTitle': '重新取数',
  'table.prevPage': '上一页',
  'table.nextPage': '下一页',
  'table.pageSizeTitle': '每页行数',
  'table.pageSize': '{n} 行/页',
  'table.filters': { other: '筛选 {count} 条' },
  'table.waitingForScan': '等待 main 发起扫描…',

  'query.run': '执行',
  'query.cancel': '取消',
  'query.runHint': '⌘⏎ 执行',
  'query.empty': '写一条语句并执行',

  'tree.loading': '加载中…',
  'tree.empty': '空',
  'tree.refresh': '刷新',
  'tree.openHint': '双击表打开',
  'tree.loadFailed': '加载失败：{error}',
  'tree.unavailable': '命名空间树不可用。',
  'tree.unavailableDetail':
    'Command Bus 目前没有 introspect 命令，preload 也没有提供 introspect 扩展通道，renderer 拿不到子节点。',
  'tree.browseWithSql': '改用 SQL 浏览对象',

  'inspector.empty': '没有选中内容',
  'inspector.fetchFull': '取全量',
  'inspector.fetching': '读取中…',
  'inspector.notFetched': '（尚未取值）',
  'inspector.fetchFailed': '读取值失败',
  'inspector.peekUnavailable': 'preload 未提供 valuePeek 通道',

  'inspector.field.type': '类型',
  'inspector.field.ttl': 'TTL',
  'inspector.field.elements': '元素数',
  'inspector.field.contentType': '内容类型',
  'inspector.field.bytesFetched': '本次字节',
  'inspector.field.bytesTotal': '全量字节',
  'inspector.field.result': '结果集',
  'inspector.field.row': '行',
  'inspector.field.column': '列',
  'inspector.field.collection': '集合',
  'inspector.field.primaryKey': '主键',
  'inspector.field.path': '路径',
  'inspector.field.field': '字段',

  'vector.notImplemented': '向量检索尚未实现',
  'vector.queryVector': '查询向量 {dim} 维',
  'vector.textQuery': '文本入口',
  'vector.plannedM4': 'M4 完善',
}
