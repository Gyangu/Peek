import type { CatalogFor } from '../../types'
import type { KeyboardMessages } from '../en/keyboard'

export const keyboard: CatalogFor<KeyboardMessages> = {
  'keyboard.panelPosition': '面板 {index}/{total}',
  'keyboard.panelPositionTitle':
    '当前面板 · {focusKeys} 移动焦点 · {panelDigitKeys} 聚焦第 N 个面板 · {moveKeys} 移动视图（加 ⌥ 则劈分出新面板）',

  'keyboard.tabPosition': '标签 {index}/{total}',
  'keyboard.tabPositionTitle':
    '当前标签 · {tabDigitKeys} 选中第 N 个标签（{lastTabKey} 为最后一个）· {cycleKeys} 循环切换 · {closeTabKey} 关闭',
}
