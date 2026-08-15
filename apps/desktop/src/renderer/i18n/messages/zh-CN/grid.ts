import type { CatalogFor } from '../../types'
import type { GridMessages } from '../en/grid'

/**
 * Chinese has a single plural category, so every plural message here fills in
 * `other` and nothing else — `formatMessage` falls back to it for any category
 * `Intl.PluralRules` reports.
 */
export const grid: CatalogFor<GridMessages> = {
  'grid.notRun': '尚未执行',
  'grid.running': '执行中…',
  'grid.noRows': '0 行',
  'grid.scrollbarLabel': '表格纵向滚动',
  'grid.columnTitle': '{name} · {type}',
  'grid.columnTitlePk': '{name} · {type} · 主键',

  'grid.rows': { other: '{rows} 行' },
  'grid.status.running': '接收中…',
  'grid.status.done': '完成',
  'grid.status.paused': '已暂停',
  'grid.status.error': '出错',
  'grid.status.idle': '空闲',
  'grid.paused': '已暂停 · 数据有效，重新执行可继续',
  'grid.pausedTitle': '{reason}。已加载的行是完整有效的数据；重新执行可继续取数。',
  'grid.truncated': '已截断',

  /* ---- 复制出去 ---------------------------------------------------- */
  'grid.copy.cell': '复制值',
  'grid.copy.cellTitle': '完整的值，与库里存的一致——不是行里显示的那段预览',
  'grid.copy.rows': { other: '复制 {count} 行' },
  'grid.copy.rowsTitle': '制表符分隔，带表头，可直接粘进表格软件',
  'grid.copy.cells': { other: '复制 {count} 个单元格' },
  'grid.copy.cellsTitle': '选中的区块，制表符分隔，带对应列的表头',
  'grid.copy.cellDone': '已复制该值。',
  'grid.copy.rowsDone': { other: '已复制 {count} 行。' },
  'grid.copy.cellsDone': { other: '已复制 {count} 个单元格。' },
  'grid.copy.notLoaded': {
    other: '有 {count} 个单元格尚未加载。',
  },
  'grid.copy.previewOnly': {
    other: '有 {count} 个值太大，窗口里只留了预览，复制的是预览。',
  },
  'grid.copy.failed': '剪贴板拒绝了这次复制。',
  'grid.truncatedTitle': '达到 maxRows 上限，后面还有数据',
  'grid.evicted': { other: '淘汰 {count} 块' },
  'grid.evictedTitle': '超出 200MB 缓存预算，远端 chunk 已按 LRU 淘汰；滚回去会显示占位符',

  'value.subtitle': '{type} · 第 {row} 行',
  'value.fetchFull': '拉取全量',
  'value.fetching': '拉取中…',
  'value.fetchFullTitle': '通过 valuePeek 拉取全量',
  'value.peekUnavailable': '当前 preload 未提供 valuePeek 通道',
  'value.fetchFailed': '拉取全量值失败',
  'value.previewOnly': '仅显示 4KB 预览',
  'value.previewHint': '，点「拉取全量」取完整内容。',
  'value.previewNoPeek': '；当前 preload 未提供 valuePeek 通道，无法取全量。',
  'value.base64': '（base64，{size}）',
  'value.base64Partial': '（base64，{size}，未读完）',

  'status.connected': '{ready}/{total} 已连接',
  'status.rows': { other: '{rows} 行' },
  'status.receiving': '接收中',
  'status.inflight': { other: '命令在途 {count}' },
  'status.cache': '缓存 {size} / {pct}%',
  'status.cacheTitle': 'renderer 结果缓存（上限 200MB，LRU 淘汰）',
  'status.resync': { other: '重对齐 {count}' },
  'status.resyncTitle': 'patch rev 断层后重新对齐的次数',
  'status.preloadMissing': 'preload 未就绪',
  'status.revTitle': 'Workspace 修订号',
}
