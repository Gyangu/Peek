import type { CatalogFor } from '../../types'
import type { ChatMessages } from '../en/chat'

/**
 * Simplified Chinese for the chat panel.
 *
 * Translation notes:
 *   - tool identifiers (`open_view`, `mcp__peek__…`) stay verbatim; they are what
 *     the agent sees and what a bug report greps for;
 *   - key notation (⏎, ⇧⏎) is not translated;
 *   - “这个窗口” is used rather than “本应用”, because the point of those labels is
 *     that the agent changed *the panel in front of you*, not the program.
 */
export const chat: CatalogFor<ChatMessages> = {
  /* ---- Shell ------------------------------------------------------- */
  'chat.title': '对话',
  'chat.newSession': '正在等待 agent…',
  'chat.session': '会话',
  'chat.noSession': '尚无会话',
  'chat.clear': '清空',
  'chat.clearTitle': '丢弃这段对话，重新开始',
  'chat.usage': '{used} / {size} tokens',
  'chat.usageTitle': '已用上下文窗口',

  /* ---- Agent status ------------------------------------------------ */
  'chat.status.idle': '空闲',
  'chat.status.starting': '正在启动 agent…',
  'chat.status.authenticating': '正在登录…',
  'chat.status.ready': '就绪',
  'chat.status.streaming': '正在回复…',
  'chat.status.awaiting-permission': '等待你确认',
  'chat.status.error': '出错',

  /* ---- Permission mode --------------------------------------------- */
  'chat.mode.label': '权限',
  'chat.mode.auto': '自动判断',
  'chat.mode.default': '每次都问我',
  'chat.mode.acceptEdits': '自动接受修改',
  'chat.mode.plan': '仅制定计划',
  'chat.mode.dontAsk': '不再询问',
  'chat.mode.bypassPermissions': '跳过全部检查',
  'chat.mode.title': '由谁来批准 agent 要调用的工具',

  /* ---- Transcript -------------------------------------------------- */
  'chat.empty.title': '问问你正在看的数据',
  'chat.empty.hint': 'Claude 可以读取这个工作区，也可以替你打开视图、执行查询、调整布局。',
  'chat.role.user': '你',
  'chat.role.agent': 'Claude',
  'chat.writing': '正在输入…',
  'chat.stop.cancelled': '已停止',
  'chat.stop.max_tokens': '达到 token 上限，已截断',
  'chat.stop.max_turn_requests': '达到请求次数上限，已截断',
  'chat.stop.refusal': '已拒绝回答',
  'chat.stop.error': '已中断',
  'chat.jumpToLatest': '回到最新',

  /* ---- Thinking ---------------------------------------------------- */
  'chat.thought': '思考过程',
  'chat.thought.show': '展开思考过程',
  'chat.thought.hide': '收起思考过程',

  /* ---- Tool calls -------------------------------------------------- */
  'chat.tool.status.pending': '排队中',
  'chat.tool.status.in_progress': '执行中',
  'chat.tool.status.completed': '已完成',
  'chat.tool.status.failed': '失败',
  'chat.tool.actedOnWindow': '改动了这个窗口',
  'chat.tool.readWindow': '读取了这个窗口',
  'chat.tool.lookup': '查找了工具',
  'chat.tool.via': '来自 {server}',
  'chat.tool.outside': 'peek 之外',
  'chat.tool.outsideTitle': '这不是 peek 的工具。它做的事发生在这个窗口之外，这里无法为其负责。',
  'chat.tool.arguments': '参数',
  'chat.tool.result': '结果',
  'chat.tool.noResult': '没有结果',
  'chat.tool.expand': '展开详情',
  'chat.tool.collapse': '收起详情',
  'chat.tool.elapsed': '{ms} ms',

  'chat.tool.peek.open_view': '打开了一个视图',
  'chat.tool.peek.activate_view': '切换到了某个视图',
  'chat.tool.peek.move_view': '移动了一个视图',
  'chat.tool.peek.set_layout': '重排了布局',
  'chat.tool.peek.run_query': '执行了一次查询',
  'chat.tool.peek.connect': '建立了一个连接',
  'chat.tool.peek.read_workspace': '读取了工作区',
  'chat.tool.peek.introspect': '查看了表结构',
  'chat.tool.peek.list_connections': '列出了连接',

  /* ---- Code blocks ------------------------------------------------- */
  'chat.code.copy': '复制',
  'chat.code.copied': '已复制',

  /* ---- Plan -------------------------------------------------------- */
  'chat.plan.title': '计划',
  'chat.plan.progress': '{done}/{total}',
  'chat.plan.status.pending': '待办',
  'chat.plan.status.in_progress': '进行中',
  'chat.plan.status.completed': '已完成',

  /* ---- Composer ---------------------------------------------------- */
  'chat.composer.placeholder': '问问这些数据…',
  'chat.composer.send': '发送',
  'chat.composer.stop': '停止',
  'chat.composer.stopTitle': '取消正在进行的这一轮',
  'chat.composer.hint': '⏎ 发送 · ⇧⏎ 换行',
  'chat.composer.busy': 'Claude 还在回复',
  'chat.composer.notReady': 'agent 还没准备好',

  /* ---- Recovering from a crash -------------------------------------- */
  'chat.retry.hint': 'agent 已经退出。再发一条消息就会重新启动它，这段对话会保留。',
  'chat.retry.placeholder': '发送消息以重新连接…',

  /* ---- Context attachments ----------------------------------------- */
  'chat.attach.label': '上下文',
  'chat.attach.add': '添加上下文',
  'chat.attach.addTitle': '把你正在看的内容附加到下一条消息',
  'chat.attach.remove': '移除',
  'chat.attach.empty': '暂无附件',
  'chat.attach.count': { other: '{count} 个附件' },
  'chat.attach.kind.rows': '行',
  'chat.attach.kind.result': '结果集',
  'chat.attach.kind.cell': '单元格',
  'chat.attach.kind.schema': '表结构',
  'chat.attach.kind.query': '查询',
  'chat.attach.kind.workspace': '工作区',
  'chat.attach.option.workspace': '当前工作区',
  'chat.attach.option.workspaceHint': '布局、已打开的视图和连接',
  'chat.attach.option.result': '{view} 的结果',
  'chat.attach.option.query': '{view} 的 SQL',
  'chat.attach.noCandidates': '目前没有可附加的内容',
  'chat.attach.sentWith': '随这条消息一起发送',

  /* ---- Permission prompt ------------------------------------------- */
  'chat.permission.title': 'Claude 想调用一个工具',
  'chat.permission.titlePeek': 'Claude 想改动这个窗口',
  'chat.permission.titlePeekRead': 'Claude 想读取这个窗口',
  'chat.permission.tool': '工具',
  'chat.permission.arguments': '参数',
  'chat.permission.kind.allow_once': '允许一次',
  'chat.permission.kind.allow_always': '始终允许',
  'chat.permission.kind.reject_once': '拒绝',
  'chat.permission.kind.reject_always': '始终拒绝',
  'chat.permission.waiting': '在你做出选择之前，对话会一直暂停。',

  /* ---- Degraded states --------------------------------------------- */
  'chat.gap.title': '对话面板尚未接通',
  'chat.gap.detail':
    'renderer 还没有通往 agent 的通道：preload 未暴露 chat delta 流，因此这里收不到任何内容。面板照常显示，方便对着它把接线补完。',
  'chat.gap.command': 'Command Bus 里还没有 “{name}” 命令，这个操作无法发送。没有任何东西被改动。',
  'chat.error.title': 'agent 报告了一个错误',
}
