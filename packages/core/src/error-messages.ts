import type { Message, MessageParams } from './messages'
import { formatMessage } from './messages'

/**
 * Canonical **English** catalog for peek-authored error messages.
 *
 * Why this lives in core instead of in the renderer's i18n directory:
 *
 * 1. main and the driver host must not know what language the window is showing.
 *    They emit `{ code, i18n: { key, params } }`; the renderer decides the words.
 * 2. But `PeekError.message` still has to carry readable English, because MCP
 *    responses, the command log and crash reports are read by tools and by
 *    developers, never by the localized UI. Keeping the English source *here*
 *    lets `peekErrorMsg()` fill `message` in automatically, so a call site
 *    declares its text exactly once. Two copies would drift within a week.
 * 3. The renderer folds this object straight into its `en` catalog, so English
 *    is never translated twice either.
 *
 * Key convention: `error.<domain>.<condition>`, domain in lowercase, condition in
 * lowerCamelCase. Keys are permanent — rename one and you silently break every
 * translation that references it.
 *
 * What does *not* belong here:
 *
 * - Text produced by the database driver itself (a PostgreSQL SQLSTATE message,
 *   a socket errno). Those stay verbatim in `PeekError.message` with no `i18n`
 *   field. See the rule in `errors.ts`.
 * - Anything only MCP or the logs will ever read. Those are plain English string
 *   literals at the call site; routing them through here implies they are
 *   translatable, and they are not.
 */
export const ERROR_MESSAGES = {
  /* ---- Command bus ------------------------------------------------- */
  'error.command.unknown': 'Unknown command {name}',
  'error.command.noHandler': 'Command {name} has no registered handler',
  'error.command.badInput': 'Invalid input for command {name}',
  'error.command.notReducible': 'Command {name} declares neither a reducer nor a reader',

  /* ---- Connections ------------------------------------------------- */
  'error.conn.notFound': 'Connection {connId} does not exist',
  'error.conn.notReady': 'Connection {label} is {status} and cannot run this yet',
  'error.conn.unsupportedCapability': 'Driver {driverId} does not support {capability}',
  'error.conn.driverNotRegistered': 'Driver {driverId} is not registered',
  'error.conn.closed': 'Connection closed',
  'error.conn.lost': 'Connection lost',
  'error.conn.serverInfoUnavailable': 'Could not read server information',
  'error.conn.connectCancelled': 'Connection attempt cancelled',
  'error.conn.killedForCancel':
    'The driver process was terminated to force the cancellation. Reconnect to continue.',

  /* ---- Driver host process ----------------------------------------- */
  'error.driver.hostBuildMissing': 'The driver host build output is missing',
  'error.driver.hostSpawnFailed': 'Could not start the driver process ({entryPath})',
  'error.driver.hostExited': 'The driver process exited',
  'error.driver.hostClosed': 'The driver host is shut down',
  'error.driver.notConnected': 'Not connected yet',
  'error.driver.cursorReleased': 'The cursor connection has already been released',
  'error.driver.streamCancelled': 'The result stream was cancelled',
  'error.driver.queryCancelled': 'The query was cancelled',

  /* ---- Views, panels, layout --------------------------------------- */
  'error.view.notFound': 'View {viewId} does not exist',
  /**
   * `view.activate` is the one command that can only act on a view already sitting
   * in a panel: "show this tab" has no meaning for a view that is not in any tab
   * bar. It is deliberately distinct from `notFound` — the view exists, it is
   * simply unplaced, and the fix is `layout.moveView`, not opening it again.
   */
  'error.view.notMounted': 'View {viewId} is not mounted in any panel',
  'error.view.kindMismatch': 'View {viewId} is a {actual} view; a {expected} patch does not apply',
  'error.view.notQuery': 'View {viewId} is not a query view',
  'error.view.createFailed': 'Could not create the query view',
  'error.panel.notFound': 'Panel {panelId} does not exist',
  'error.panel.splitFailed': 'Panel {panelId} cannot be split',
  'error.layout.splitNotFound': 'Split {splitId} does not exist',
  'error.layout.ratioLength': 'Expected {expected} ratio values, got {actual}',
  'error.layout.noPanels': 'The layout tree contains no panels',
  'error.layout.tooManyPanels': 'A layout holds at most {max} panels',
  'error.layout.tooManyTabs': 'A panel holds at most {max} tabs',
  'error.layout.tooDeep': 'A layout nests at most {max} levels deep',
  'error.layout.revMismatch':
    'The workspace has changed since revision {expected} (it is now {actual}); read it again and retry',
  'error.layout.wouldUnplace':
    'The target layout leaves out {count} open view(s); pass unplaced="close" to close them or "keep" to unmount them',

  /* ---- Chat (ACP agent panel) -------------------------------------- */
  'error.chat.notChatView': 'View {viewId} is a {kind} view, not a conversation',
  'error.chat.busy': 'The conversation is already running a turn; stop it before sending another',
  'error.chat.awaitingPermission':
    'The conversation is waiting for a permission decision; answer it before sending',
  'error.chat.tooManyAttachments': 'A conversation stages at most {max} attachments',
  'error.chat.attachViewMissing': 'Cannot attach: view {viewId} is not open any more',
  'error.chat.attachResultMissing': 'Cannot attach: result set {resultId} is not available any more',
  'error.chat.attachResultMismatch': 'Result set {resultId} does not belong to view {viewId}',
  'error.chat.attachNotQueryView': 'View {viewId} is a {kind} view and has no statement to attach',
  'error.chat.attachConnMissing': 'Cannot attach a schema: connection {connId} is not open',
  'error.chat.attachmentNotStaged': 'Attachment {attachmentId} is not staged on this conversation',
  'error.chat.noPendingPermission': 'The conversation is not waiting for a permission decision',
  'error.chat.permissionStale':
    'Permission request {requestId} is no longer the one being asked (it is now {actual}); read the conversation again',
  'error.chat.permissionOptionUnknown': 'No such permission option {optionId}; the choices are {options}',
  /**
   * Not a capability check but a policy one: a mode that removes the human from
   * the loop may only be chosen by the human. See `ChatSetModeInputSchema`.
   */
  'error.chat.modeNotAllowed':
    'Permission mode {mode} can only be chosen by the person at the keyboard, not by {source}',
  'error.chat.agentUnavailable': 'The chat agent is not available',

  /* ---- Queries and result sets ------------------------------------- */
  'error.query.emptyText': 'The statement is empty',
  'error.query.needViewOrConn': 'Provide either viewId, or connId together with text',
  'error.query.needResultOrView': 'Provide either resultId or viewId',
  'error.query.noRunningResult': 'View {viewId} has no result set running',
  'error.query.alreadyRunning': 'Result set {resultId} is already running',
  'error.query.timedOut': '{operation} timed out after {ms}ms',
  'error.result.notFound': 'Result set {resultId} does not exist',
  'error.result.stale': 'Result set {resultId} is no longer valid; values cannot be re-fetched',
  'error.result.sampleNoWindow': 'No application window is available to sample the result set from',
  'error.result.sampleTimedOut': 'Timed out while sampling the result set from the window',
  'error.result.sampleChannelClosed': 'The sampling channel was closed',
  'error.result.sampleFailed': 'Sampling the result set failed',

  /* ---- Value inspection -------------------------------------------- */
  'error.value.gone': 'The value is gone (the row was deleted or the result set changed)',
  'error.value.columnOutOfRange': 'Column index {col} is out of range ({total} columns)',
  'error.value.columnNotFound': 'No such column: {column}',
  'error.value.primaryKeyRequired': 'A primary key value is required to inspect this cell',
  'error.value.primaryKeyNotFound': 'No such primary key column: {column}',

  /* ---- Query building (identifiers, filters, cursors) --------------- */
  'error.sql.identifierEmpty': 'An identifier cannot be empty',
  'error.sql.identifierInvalid': 'Identifier contains an illegal character: {name}',
  'error.sql.filterMissingValue': 'Filter {column} {op} is missing a value',
  'error.sql.filterValueNotArray': 'Filter {column} in requires an array value',
  'error.sql.invalidCursorToken': 'Malformed cursorToken: {token}',

  /* ---- Introspection ----------------------------------------------- */
  'error.introspect.unknownNodeId': 'Unrecognized node id: {nodeId}',
  'error.introspect.collectionKindUnsupported':
    'PostgreSQL only supports relation collections, got {kind}',
  'error.introspect.relationNotFound': 'Relation does not exist or has no visible columns: {name}',
  /**
   * The driver-neutral sibling of `collectionKindUnsupported`, which names
   * PostgreSQL in its text and therefore cannot be reused by redis or qdrant.
   * Kept as a second key rather than a reworded first one: the postgres wording
   * is already translated, already asserted on, and renaming a key silently
   * breaks every translation referencing it.
   */
  'error.collection.kindUnsupported': 'Driver {driverId} cannot browse a {kind} collection',
  'error.collection.notFound': 'Collection does not exist: {name}',

  /* ---- Key/value stores (redis) ------------------------------------ */
  'error.key.notFound': 'Key does not exist: {key}',
  'error.key.pathRequired': 'A {type} value needs a path (field, index or member) to address an element',
  'error.key.pathInvalid': 'Cannot address {path} inside a {type} value',
  'error.key.typeUnsupported': 'Unsupported redis value type: {type}',

  /* ---- Vector search (qdrant) -------------------------------------- */
  'error.vector.queryRequired': 'A vector search needs exactly one of queryVec or queryPointId',
  'error.vector.dimensionMismatch':
    'The query vector has {actual} dimensions; collection {collection} expects {expected}',
  'error.vector.nameRequired':
    'Collection {collection} defines several named vectors; pass vectorName (one of: {names})',
  'error.vector.nameUnknown': 'Collection {collection} has no vector named {name}',
  'error.vector.pointNotFound': 'Point {pointId} does not exist in collection {collection}',

  /* ---- Local database files (sqlite) ------------------------------- */
  'error.file.notFound': 'Database file does not exist: {file}',
  'error.file.notReadable': 'Database file cannot be read: {file}',
} as const

export type ErrorMessageCatalog = typeof ERROR_MESSAGES

/**
 * Every valid `PeekError.i18n.key`.
 *
 * Adding a member here without adding it to the renderer's zh-CN error catalog is
 * a compile error in the renderer — that is the whole point of freezing the union
 * in core rather than typing the key as a bare `string`.
 */
export type ErrorMessageKey = keyof ErrorMessageCatalog

export type ErrorMessageParams<K extends ErrorMessageKey> = MessageParams<ErrorMessageCatalog[K]>

export const ERROR_MESSAGE_KEYS = Object.keys(ERROR_MESSAGES) as readonly ErrorMessageKey[]

/** Render an error key as canonical English. Used to fill `PeekError.message`. */
export function formatErrorMessage(key: ErrorMessageKey, params?: Record<string, string | number>): string {
  const message: Message = ERROR_MESSAGES[key]
  return formatMessage(message, 'en', params)
}
