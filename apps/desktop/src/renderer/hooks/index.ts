/**
 * Renderer hooks and the pure logic behind them.
 *
 * The barrel exists so components import from one place; the modules themselves
 * stay split between "pure, unit-tested logic" (`layout-nav`, `shortcuts`, the
 * predicates in `usePanelFocus` and the phrase builders in `announce`) and
 * "React glue" (`useGlobalKeys` and the hooks proper).
 */

export {
  DIRECTIONS,
  arrowDirection,
  directionPlacement,
  directionZone,
  findPanelInDirection,
  panelBoxes,
  panelIdAt,
  type Direction,
  type PanelBox,
} from './layout-nav'

export {
  MAX_PANEL_DIGIT,
  MAX_TAB_DIGIT,
  chordOf,
  isMacPlatform,
  resolveShortcut,
  shortcutHints,
  type KeyChord,
  type ShortcutAction,
  type ShortcutContext,
  type ShortcutHints,
} from './shortcuts'

export { useGlobalKeys } from './useGlobalKeys'

/* Escape ownership and focus containment, shared by every modal in the window. */
export {
  isTopModal,
  modalDepth,
  nextFocusIndex,
  popModal,
  pushModal,
  resetModalStack,
  type ModalId,
} from './modalStack'

export { useModalDialog, type ModalDialogOptions } from './useModalDialog'

/* The focus contract the panel and its tab strip share. `PanelFocusApi` is the
 * only thing the two components pass between them. */
export {
  composeRefs,
  focusAdoption,
  focusEntryDispatches,
  isFocusEnteringPanel,
  panelTabDomId,
  panelTabpanelDomId,
  rovingIndex,
  shouldAdoptFocus,
  usePanelFocus,
  useTabRoving,
  type PanelFocusApi,
  type TabRovingApi,
  type TabRovingOptions,
} from './usePanelFocus'

export {
  announce,
  panelAriaLabel,
  panelContentPhrase,
  panelFocusMessage,
  panelPositionOf,
  tabActivationMessage,
  tabPositionOf,
  useAnnouncement,
  useLayoutAnnouncer,
  type Position,
} from './announce'
