/**
 * "Add what I am looking at to the conversation" — the renderer half.
 *
 * The main-process half (`main/acp/context`) turns a descriptor into text a model
 * reads accurately. This half is how a descriptor comes to exist: a selection
 * model the grid holds, the menu of what can be attached from a given place, and
 * the disclosure that data leaves the machine.
 *
 * ## Where each piece is mounted
 *
 * 1. `startChat()` calls `setContextActionPort(...)` at start-up, which is what
 *    turns dispatch on. Until it does, every surface here is live but inert and
 *    says so once in the console (`port.ts` explains why that beats a cast);
 * 2. `DataGrid` holds the `RowSelection` and updates it with `applyRowClick` —
 *    the row-number gutter selects, ⇧ extends, ⌘/ctrl toggles;
 * 3. `DataGrid` renders `<SelectionActionBar>` as a sibling of `.grid` (it is
 *    `position: absolute`, so inside the horizontal scroll container it would
 *    slide away), and `<ContextMenu>` on right-click;
 * 4. the chat panel's own `AttachmentBar` covers the other direction — the user
 *    is looking at the conversation rather than at the grid — and goes through
 *    `useContextActions` too, so the disclosure gate is the same one.
 *
 * `detailFor` is consumed by the transcript's attachment receipts
 * (`chat/MessageItem.tsx`): the chip strip shows what is *staged*, and what was
 * actually sent is only known afterwards.
 */

export {
  EMPTY_SELECTION,
  MAX_SELECTION_SPAN,
  applyRowClick,
  clearSelection,
  isRowSelected,
  selectAllRows,
  selectedIndexes,
  selectionSize,
  selectionSpan,
  type ClickModifiers,
  type RowSelection,
} from './selection'

export {
  RESULT_ATTACHMENT_MAX_ROWS,
  cellAttachment,
  collectionRefOf,
  contextActionsFor,
  queryAttachment,
  resultAttachment,
  rowsAttachment,
  schemaAttachment,
  workspaceAttachment,
  type ContextAction,
  type ContextActionId,
  type ContextTarget,
} from './descriptors'

export {
  CONSENT_VERSION,
  grantContextConsent,
  hasContextConsent,
  resetContextConsentCache,
  revokeContextConsent,
  subscribeContextConsent,
} from './consent'

export {
  getContextActionPort,
  resetContextActionPort,
  setContextActionPort,
  type ContextActionPort,
} from './port'

export { useContextActions, type ContextActionsApi } from './useContextActions'

export { ConsentDialog, type ConsentDialogProps } from './ConsentDialog'
export { ContextMenu, type ContextMenuExtraItem, type ContextMenuProps } from './ContextMenu'
export { SelectionActionBar, type SelectionActionBarProps } from './SelectionActionBar'
export { detailFor, type AttachmentStatus } from './chipDetail'
