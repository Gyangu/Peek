import type { ErrorMessageCatalog } from '@peek/core'
import type { CatalogFor } from '../../types'

/**
 * Chinese renderings of the error catalog that `@peek/core` declares in English.
 *
 * Typed against `ErrorMessageCatalog`, so adding a key in core without adding it
 * here fails the renderer build. That is the deliberate coupling: main can only
 * emit keys the window knows how to say.
 *
 * Errors whose text came from the database driver never reach this file — they
 * arrive with no `i18n` descriptor and are shown verbatim.
 */
export const errors: CatalogFor<ErrorMessageCatalog> = {
  /* ---- Command bus ------------------------------------------------- */
  'error.command.unknown': '未知命令 {name}',
  'error.command.noHandler': '命令 {name} 没有注册 handler',
  'error.command.badInput': '命令 {name} 入参不合法',
  'error.command.notReducible': '命令 {name} 既没有 reduce 也没有 read',

  /* ---- Connections ------------------------------------------------- */
  'error.conn.notFound': '连接 {connId} 不存在',
  'error.conn.notReady': '连接 {label} 当前状态是 {status}，还不能执行',
  'error.conn.unsupportedCapability': '驱动 {driverId} 不支持 {capability}',
  'error.conn.driverNotRegistered': '尚未注册驱动：{driverId}',
  'error.conn.closed': '连接已关闭',
  'error.conn.lost': '连接已断开',
  'error.conn.serverInfoUnavailable': '无法读取服务端信息',
  'error.conn.connectCancelled': '建连已取消',
  'error.conn.killedForCancel': '为强制取消已终止 driver 进程，请重新连接。',

  /* ---- Driver host process ----------------------------------------- */
  'error.driver.hostBuildMissing': 'driver host 构建产物缺失',
  'error.driver.hostSpawnFailed': '无法启动 driver 进程（{entryPath}）',
  'error.driver.hostExited': 'driver 进程已退出',
  'error.driver.hostClosed': 'driver host 已关闭',
  'error.driver.notConnected': '尚未建立连接',
  'error.driver.cursorReleased': '游标连接已释放',
  'error.driver.streamCancelled': '结果流已被取消',
  'error.driver.queryCancelled': '查询已被取消',

  /* ---- Views, panels, layout --------------------------------------- */
  'error.view.notFound': '视图 {viewId} 不存在',
  'error.view.notMounted': '视图 {viewId} 不在任何面板里',
  'error.view.kindMismatch': '视图 {viewId} 是 {actual}，不能用 {expected} 补丁更新',
  'error.view.notQuery': '视图 {viewId} 不是查询视图',
  'error.view.createFailed': '查询视图创建失败',
  'error.panel.notFound': '面板 {panelId} 不存在',
  'error.panel.splitFailed': '面板 {panelId} 无法劈分',
  'error.layout.splitNotFound': 'split {splitId} 不存在',
  'error.layout.ratioLength': 'ratio 长度应为 {expected}，收到 {actual}',
  'error.layout.noPanels': '布局树里没有任何面板',
  'error.layout.tooManyPanels': '一个布局最多容纳 {max} 个面板',
  'error.layout.tooManyTabs': '一个面板最多容纳 {max} 个标签页',
  'error.layout.tooDeep': '布局树最多嵌套 {max} 层',
  'error.layout.revMismatch': '工作区已从版本 {expected} 变化到 {actual}，请重新读取后重试',
  'error.layout.wouldUnplace': '目标布局遗漏了 {count} 个已打开的视图；用 unplaced="close" 关闭它们，或 "keep" 让它们卸载但保留',

  /* ---- Queries and result sets ------------------------------------- */
  'error.query.emptyText': '查询语句为空',
  'error.query.needViewOrConn': '需要 viewId，或者 connId + text',
  'error.query.needResultOrView': '需要 resultId 或 viewId',
  'error.query.noRunningResult': '视图 {viewId} 当前没有在跑的结果集',
  'error.query.alreadyRunning': '结果集 {resultId} 已在执行中',
  'error.query.timedOut': '{operation} 超时（{ms}ms）',
  'error.result.notFound': '结果集 {resultId} 不存在',
  'error.result.stale': '结果集 {resultId} 已失效，无法回源取值',
  'error.result.sampleNoWindow': '没有可用的界面窗口，无法取样结果集',
  'error.result.sampleTimedOut': '向界面取样结果集超时',
  'error.result.sampleChannelClosed': '取样通道已关闭',
  'error.result.sampleFailed': '界面取样失败',

  /* ---- Value inspection -------------------------------------------- */
  'error.value.gone': '目标值不存在（行已被删除或结果集已变化）',
  'error.value.columnOutOfRange': '列下标越界：{col}（共 {total} 列）',
  'error.value.columnNotFound': '列不存在：{column}',
  'error.value.primaryKeyRequired': '检查该单元格需要给出主键值',
  'error.value.primaryKeyNotFound': '主键列不存在：{column}',

  /* ---- Query building ---------------------------------------------- */
  'error.sql.identifierEmpty': '标识符不能为空',
  'error.sql.identifierInvalid': '标识符含非法字符：{name}',
  'error.sql.filterMissingValue': '筛选条件 {column} {op} 缺少 value',
  'error.sql.filterValueNotArray': '筛选条件 {column} in 的 value 必须是数组',
  'error.sql.invalidCursorToken': '非法的 cursorToken：{token}',

  /* ---- Introspection ----------------------------------------------- */
  'error.introspect.unknownNodeId': '无法识别的节点 id：{nodeId}',
  'error.introspect.collectionKindUnsupported': 'PostgreSQL 只支持 relation 类型的集合，收到 {kind}',
  'error.introspect.relationNotFound': '表不存在或没有可见列：{name}',
  'error.collection.kindUnsupported': '驱动 {driverId} 无法浏览 {kind} 类型的集合',
  'error.collection.notFound': '集合不存在：{name}',

  /* ---- Key/value stores (redis) ------------------------------------ */
  'error.key.notFound': 'key 不存在：{key}',
  'error.key.pathRequired': '{type} 类型的值需要给出 path（field / 下标 / member）才能定位元素',
  'error.key.pathInvalid': '无法在 {type} 类型的值里定位 {path}',
  'error.key.typeUnsupported': '不支持的 redis 值类型：{type}',

  /* ---- Vector search (qdrant) -------------------------------------- */
  'error.vector.queryRequired': '向量检索需要且只需要 queryVec 与 queryPointId 其中之一',
  'error.vector.dimensionMismatch': '查询向量是 {actual} 维，集合 {collection} 需要 {expected} 维',
  'error.vector.nameRequired': '集合 {collection} 有多个命名向量，请指定 vectorName（可选：{names}）',
  'error.vector.nameUnknown': '集合 {collection} 没有名为 {name} 的向量',
  'error.vector.pointNotFound': '集合 {collection} 里不存在 point {pointId}',

  /* ---- Local database files (sqlite) ------------------------------- */
  'error.file.notFound': '数据库文件不存在：{file}',
  'error.file.notReadable': '数据库文件无法读取：{file}',

  /* ---- Chat（ACP 助手面板） ---------------------------------------- */
  'error.chat.notChatView': '视图 {viewId} 是 {kind} 视图，不是对话',
  'error.chat.busy': '这轮对话还在进行中，先停止再发送下一条',
  'error.chat.awaitingPermission': '对话正在等待授权，先做出选择再发送',
  'error.chat.tooManyAttachments': '一个对话最多附带 {max} 项上下文',
  'error.chat.attachViewMissing': '无法附加：视图 {viewId} 已经不在了',
  'error.chat.attachResultMissing': '无法附加：结果集 {resultId} 已经不可用',
  'error.chat.attachResultMismatch': '结果集 {resultId} 不属于视图 {viewId}',
  'error.chat.attachNotQueryView': '视图 {viewId} 是 {kind} 视图，没有可附加的语句',
  'error.chat.attachConnMissing': '无法附加表结构：连接 {connId} 未打开',
  'error.chat.attachmentNotStaged': '附件 {attachmentId} 不在这个对话的待发送列表里',
  'error.chat.noPendingPermission': '对话当前没有待授权的请求',
  'error.chat.sessionOpen': '对话 {sessionId} 正在视图 {viewId} 中打开，先关掉它再删除',
  'error.chat.permissionStale': '授权请求 {requestId} 已经不是当前那一条（现在是 {actual}），请重新读取对话',
  'error.chat.permissionOptionUnknown': '没有 {optionId} 这个授权选项，可选：{options}',
  'error.chat.modeNotAllowed': '授权模式 {mode} 只能由本人在界面上选择，{source} 无权切换',
  'error.chat.permissionNotAnswerableByAgent':
    '权限提示只能由键盘前的本人、或从外部驱动 peek 的 operator 来回答，peek 自己的聊天面板无权代答',
  'error.chat.agentUnavailable': '聊天助手当前不可用',

  /* ---- agent 提问（ask 工具） ---- */
  'error.chat.noPendingQuestion': '这个对话现在没有在等你回答',
  'error.chat.askDuplicateOption': '有两个选项用了同一个 optionId，每个都得不一样',
  'error.chat.questionStale': '问题 {requestId} 已经不是当前在问的那个了（现在是 {actual}），请重新读一次对话',
  'error.chat.answerRejected': '这不是这个问题的有效答案；可选是 {options}，而单选题只能选一个',
  'error.chat.answerNotAnswerableByAgent':
    'agent 提的问题只能由键盘前的本人、或从外部驱动 peek 的 operator 来回答，agent 永远无权代答',
}
