import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  Columns2,
  Database,
  Folder,
  Hash,
  KeyRound,
  Layers,
  Layers2,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RotateCw,
  Rows2,
  Settings,
  Square,
  Table2,
  Tag,
  Timer,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Which concept wears which icon. The whole of it, and the only copy.
 *
 * Importing `<X />` straight into a call site is the cheaper spelling and the
 * wrong one, for the same reason a call site may not write a colour: **"which
 * icon means which thing" is spec, and spec lives in one file.** Spread across
 * twenty modules, the next author reaching for "close" has no way to discover
 * that "close" already had an answer — which is precisely how this codebase
 * ended up with three independent implementations of a destructive button
 * before `spec.ts` existed.
 *
 * The keys are **semantic**, never shapes. A call site says "there is a close
 * here", not "there is a cross here". Swapping a glyph, or the whole library,
 * then touches this table and nothing else. Action-shaped keys reuse the
 * Command Bus vocabulary (`panel.splitRow`), which is also the i18n key and the
 * `data-peek-action` handle — so what a control is called, what it announces
 * and what it draws are one name.
 *
 * This table is static, so everything listed here ships. List what is worn;
 * do not stock the shelf.
 *
 * Design record: docs/design/2026-08-15-icon-set.md
 */
export const ICONS = {
  /*
   * The pair this table was created for. `⊞`/`⊟` read as add/collapse — one
   * axis of opening and closing — and were carrying left/right vs top/bottom,
   * which are two orthogonal directions. These two differ by the direction of
   * one dividing line and by nothing else, so the shape *is* the meaning.
   */
  'panel.splitRow': Columns2,
  'panel.splitCol': Rows2,

  close: X,
  /** Start a new thing — the chat rail's new conversation. */
  create: Plus,
  refresh: RotateCw,
  /*
   * The two side panels fold away, and they fold in **opposite** directions —
   * the sidebar is on the left and closes leftwards, the chat rail is on the
   * right and closes rightwards. So a shared `collapse` icon is impossible:
   * the same chevron means "close" on one and "open" on the other. Four names,
   * one per panel per state, each spelled as the i18n key already in use.
   *
   * Not `disclosure.*` either: a disclosure turns 90° between its states
   * because it points *at* what it opens. These point where the panel travels.
   */
  'sidebar.collapse': ChevronLeft,
  'sidebar.expand': ChevronRight,
  'chat.sessions.collapse': ChevronRight,
  'chat.sessions.expand': ChevronLeft,
  'settings.open': Settings,
  /** A saved credential on a connection row. Was the one colour emoji in a monochrome window. */
  credential: KeyRound,

  'sort.asc': ArrowUp,
  'sort.desc': ArrowDown,
  'page.prev': ArrowLeft,
  'page.next': ArrowRight,

  /** A disclosure is geometry: the two states differ by 90°, as they always did. */
  'disclosure.open': ChevronDown,
  'disclosure.closed': ChevronRight,

  /*
   * Namespace node kinds. The set `TreeView` used to draw — ⛁ ❏ ▦ ◫ ◪ ⧉ ◇ —
   * asked the reader to tell apart symbols that differ by which half is filled,
   * at a size the type scale had squeezed to a single rung. Its own comment
   * predicted this would stop working and prescribed a size; the honest fix was
   * a set that contains the concepts.
   */
  'node.database': Database,
  'node.folder': Folder,
  'node.table': Table2,
  /** A view is a table seen through something, hence a stack rather than a variant of the table. */
  'node.view': Layers,
  'node.materializedView': Layers2,
  'node.keyspace': Boxes,
  'node.key': Tag,
  'node.collection': Boxes,
  'node.index': Hash,
  'node.column': Minus,

  /*
   * Run status. The old set leaned on `◐` for "in progress", a half-filled
   * circle that reads as a state of *fill* rather than of motion; these four
   * share one outer ring and differ by what is inside it.
   */
  'status.completed': CircleCheck,
  'status.failed': CircleX,
  'status.running': LoaderCircle,
  'status.pending': Circle,
  'status.active': CircleDot,

  check: Check,
  warn: TriangleAlert,
  /** A query or scan is running and can be stopped. A filled square, as on any transport. */
  stop: Square,
  run: Play,
  'autoRefresh.timer': Timer,
  'arrow.down': ArrowDown,
} as const satisfies Record<string, LucideIcon>

export type IconName = keyof typeof ICONS
