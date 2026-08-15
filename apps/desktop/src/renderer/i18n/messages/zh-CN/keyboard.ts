import type { CatalogFor } from '../../types'
import type { KeyboardMessages } from '../en/keyboard'

export const keyboard: CatalogFor<KeyboardMessages> = {
  'keyboard.panelPosition': '面板 {index}/{total}',
  'keyboard.panelPositionTitle':
    '当前面板 · {focusKeys} 移动焦点 · {panelDigitKeys} 聚焦第 N 个面板 · {moveKeys} 移动视图（加 ⌥ 则劈分出新面板）',

  'keyboard.tabPosition': '标签 {index}/{total}',
  'keyboard.tabPositionTitle':
    '当前标签 · {tabDigitKeys} 选中第 N 个标签（{lastTabKey} 为最后一个）· {cycleKeys} 循环切换 · {closeTabKey} 关闭',

  'keys.sheet.title': '键盘快捷键',

  'keys.scope.window': '窗口',
  'keys.scope.grid': '结果表格',
  'keys.scope.composer': '聊天输入框',
  'keys.scope.nav': '列表、标签与菜单',
  'keys.scope.modal': '对话框',
  'keys.scope.menu': '应用菜单',

  'keys.panel.splitRow': '左右劈分面板',
  'keys.panel.splitCol': '上下劈分面板',
  'keys.panel.close': '关闭面板及其中所有标签',
  'keys.panel.focusIndex': '聚焦第 N 个面板',
  'keys.panel.focusDirection': '把焦点移到那个方向的面板',

  'keys.tab.close': '关闭当前标签',
  'keys.tab.select': '显示第 N 个标签（最后一个数字显示末尾标签）',
  'keys.tab.cycleNext': '显示下一个标签',
  'keys.tab.cyclePrev': '显示上一个标签',

  'keys.view.moveDirection': '把视图移进那个方向的面板',
  'keys.view.splitDirection': '把视图移到那个面板之外，新开一个面板',

  'keys.app.settings': '打开设置',
  'keys.app.shortcuts': '查看键盘快捷键',
  'keys.app.leaveTextEntry': '退出文本编辑器',

  'keys.menu.zoomActual': '实际大小',
  'keys.menu.zoomIn': '放大',
  'keys.menu.zoomOut': '缩小',

  'keys.grid.selectAll': '选中所有行',
  'keys.grid.copy': '复制选区',
  'keys.grid.jumpEdge': '跳到首行或末行',
  'keys.grid.clearSelection': '清除选区',

  'keys.composer.send': '发送消息',
  'keys.composer.newline': '换行',
  'keys.composer.mention': '引用表、视图或文件',

  'keys.nav.move': '在条目间移动',
  'keys.nav.activate': '打开高亮的条目',

  'keys.modal.close': '关闭对话框',
  'keys.modal.cycleFocus': '移到下一个控件',

  'keys.settings.record': '修改「{name}」的快捷键',
  'keys.settings.recording': '请按下组合键…',
  'keys.settings.reset': '恢复默认',
  'keys.settings.resetAll': '全部恢复默认',
  'keys.settings.showSheet': '查看快捷键一览',
  'keys.settings.off': '已关闭',
  'keys.settings.conflict': '与这些快捷键重复：{others}',
  'keys.settings.readOnly': '这些是系统约定的按键，不能修改。',
}
