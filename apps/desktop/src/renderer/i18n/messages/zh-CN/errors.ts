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
  'error.view.kindMismatch': '视图 {viewId} 是 {actual}，不能用 {expected} 补丁更新',
  'error.view.notQuery': '视图 {viewId} 不是查询视图',
  'error.view.createFailed': '查询视图创建失败',
  'error.panel.notFound': '面板 {panelId} 不存在',
  'error.panel.splitFailed': '面板 {panelId} 无法劈分',
  'error.layout.splitNotFound': 'split {splitId} 不存在',
  'error.layout.ratioLength': 'ratio 长度应为 {expected}，收到 {actual}',
  'error.layout.noPanels': '布局树里没有任何面板',

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
}
