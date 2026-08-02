import type { CatalogFor } from '../../types'
import type { SettingsMessages } from '../en/settings'

export const settings: CatalogFor<SettingsMessages> = {
  /* ---------------- 外壳 ---------------- */
  'settings.open': '设置',
  'settings.title': '设置',
  'settings.close': '关闭',
  'settings.done': '完成',
  'settings.sections': '设置分类',
  'settings.section.mcp': 'MCP 端点',
  'settings.section.appearance': '外观',
  'settings.section.timeouts': '查询与超时',
  'settings.section.about': '关于',

  /* ---------------- MCP 端点 ---------------- */
  'mcp.title': 'MCP 端点',
  'mcp.intro': 'AI 客户端通过它连到这个窗口。',
  'mcp.state': '状态',
  'mcp.stateListening': '监听中',
  'mcp.stateDown': '未运行 —— 任何 AI 客户端都连不到这个窗口',
  'mcp.stateRestarting': '重启中…',
  'mcp.stateUnknown': '检查中…',
  'mcp.endpoint': '地址',
  'mcp.token': 'Token',
  'mcp.reveal': '显示',
  'mcp.hide': '隐藏',
  'mcp.copyToken': '复制 token',
  'mcp.copyCommand': '复制 claude mcp add 命令',
  'mcp.commandCopied': '命令已复制。粘贴到终端即可注册这个窗口。',
  'mcp.tokenCopied': 'Token 已复制。',
  'mcp.copyFailed': '剪贴板不可用，请选中文本手动复制。',
  'mcp.noCommandYet': '端点开始监听之前没有命令可复制。',
  'mcp.port': '端口',
  'mcp.applyPort': '应用端口',
  'mcp.portInvalid': '端口必须是 1 到 65535 之间的整数。',
  'mcp.portUnchanged': '当前用的就是这个端口。',
  'mcp.portApplied': '端口已保存，之后每次启动都会用它。',
  'mcp.portFallback': '端口 {preferred} 被占用，端点实际在 {actual}。请重新复制命令，或者腾出该端口后再应用一次。',
  'mcp.rotateToken': '轮换 token',
  'mcp.rotateWarning': '轮换 token、或者更换端口，都会让已经注册过的 AI 客户端全部失效 —— 需要在每个客户端里重新执行上面这条命令。',
  'mcp.tokenRotated': '新 token 已生效。旧的从现在起一律拒绝，请重新注册你的客户端。',
  'mcp.reregisterRequired': '端点已经变了，请用上面的命令重新注册 AI 客户端。',

  /* ---------------- 外观 ---------------- */
  'settings.language': '语言',
  'settings.languageHint': '立即生效，并记在这台机器上。',
  'settings.zoom': '界面大小',
  'settings.zoomHint': '整体缩放窗口——文字、行高、控件一起放大，{keys} 是同一件事。',

  /* ---------------- 查询与超时 ---------------- */
  'settings.timeouts.intro': '一个请求最多能跑多久，超过就放弃。没有人显式指定期限时用这里的值。',
  'settings.timeouts.query': '查询',
  'settings.timeouts.scan': '集合扫描',
  'settings.timeouts.vectorSearch': '向量检索',
  'settings.timeouts.seconds': '秒',
  'settings.timeouts.zeroHint': '填 0 表示不设上限。',
  'settings.timeouts.invalid': '超时必须是 0 到 3600 之间的整数秒。',
  'settings.timeouts.apply': '应用',
  'settings.timeouts.applied': '已保存。从现在起发出的请求按新值执行。',
  'settings.timeouts.unchanged': '当前用的就是这些值。',
  'settings.timeouts.stageNote':
    'driver-host 协议自己还有一套内部超时。它们是 peek 防着 driver 进程卡死用的，不是偏好，所以不放在这里。',

  /* ---------------- 关于 ---------------- */
  'settings.about.version': '版本',
  'settings.about.configDir': '配置目录',
  'settings.about.settingsFile': '设置',
  'settings.about.connectionsFile': '连接',
  'settings.about.mcpFile': 'MCP 端点',
  'settings.about.pathsHint': 'peek 写下的一切都在这些文件里。PEEK_CONFIG_DIR 会把它们整体挪走。',
  'settings.about.unavailable': '不可用',
}
