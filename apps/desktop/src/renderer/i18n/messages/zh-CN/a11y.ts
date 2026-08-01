import type { CatalogFor } from '../../types'
import type { A11yMessages } from '../en/a11y'

export const a11y: CatalogFor<A11yMessages> = {
  'a11y.panel.label': '面板 {index}：{title}',
  'a11y.panel.empty': '空面板 {index}',

  'a11y.tab.position': '{title}，第 {index} 个标签，共 {total} 个',

  'a11y.announce.panelFocused': '第 {index} 个面板，共 {total} 个，{content}',
  'a11y.announce.tabActivated': '{content}，第 {index} 个面板，共 {total} 个',

  'a11y.region.label': '布局播报',

  'panel.tabs.listLabel': '面板标签页',
  'panel.tab.close': '关闭 {title}',
}
