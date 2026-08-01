import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ChatId, ChatMessageId } from '@peek/core'
import { useChatT } from './i18n'
import { MessageItem } from './MessageItem'
import { subscribeChat, useChatMessage, useChatMessageIds } from './transcriptStore'

/* ==================================================================
 * The transcript list.
 *
 * ## Why TanStack Virtual here, when DataGrid refuses it for rows
 *
 * DataGrid drives its row axis with the in-house `VScrollDriver` because a
 * result set can hold 100M rows, and `rowCount × ROW_H` overflows Chromium's
 * element-height cap long before that — there is no spacer tall enough. The
 * in-house driver buys that at the price of a **fixed row height**.
 *
 * Chat messages are the opposite problem: there are hundreds of them, not
 * millions (a spacer for 10,000 messages is nowhere near the cap), and no two
 * are the same height — one is a word, the next is a table and a code block. So
 * the trade runs the other way, and the dependency already in the tree that does
 * variable heights with `ResizeObserver` measurement is the right tool.
 *
 * ## Keeping streaming off the list
 *
 * `useChatMessageIds` subscribes to the id array, whose reference changes only
 * when a message is added or removed. Tokens streaming into an existing message
 * therefore never re-render this component; they re-render one `MessageRow`,
 * whose height change reaches the virtualizer through `measureElement`.
 *
 * ## Following the bottom
 *
 * Pinned to the end while the user is already at the end, released the moment
 * they scroll up — a transcript that yanks itself back down while you are
 * reading history is worse than one that does not follow at all. A "jump to
 * latest" button appears instead, and re-arms the follow.
 * ================================================================== */

/** How far from the bottom still counts as "at the bottom", in pixels. */
const FOLLOW_SLACK_PX = 48

/** First-render height guess. Wrong is fine — every row is measured on mount. */
const ESTIMATED_MESSAGE_H = 96

const OVERSCAN = 6

export function MessageList({ chatId }: { chatId: ChatId }): ReactElement {
  const t = useChatT()
  const ids = useChatMessageIds(chatId)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const follow = useRef(true)
  const rafRef = useRef(0)
  const [showJump, setShowJump] = useState(false)

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_MESSAGE_H,
    overscan: OVERSCAN,
    // Keyed by message id, so a measured height follows its message rather than
    // its position when something is inserted.
    getItemKey: (index) => ids[index] ?? index,
  })

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  /** Coalesce follow-scrolls to one per frame; a burst of deltas must not thrash. */
  const scheduleFollow = useCallback(() => {
    if (!follow.current || rafRef.current !== 0) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      if (follow.current) scrollToBottom()
    })
  }, [scrollToBottom])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance <= FOLLOW_SLACK_PX
    if (atBottom !== follow.current) {
      follow.current = atBottom
      // Only crosses into React when the state actually flips, so an ordinary
      // scroll gesture costs no renders at all.
      setShowJump(!atBottom)
    }
  }, [])

  // A message was added or removed: stay pinned if we were pinned.
  useLayoutEffect(() => {
    scheduleFollow()
  }, [ids, scheduleFollow])

  /**
   * Text streaming into the last message does not re-render this component (by
   * design), so the follow is driven imperatively off the store instead. React
   * never hears about it — the callback only moves `scrollTop`.
   */
  useEffect(() => {
    const off = subscribeChat(chatId, scheduleFollow)
    scheduleFollow()
    return () => {
      off()
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [chatId, scheduleFollow])

  const items = virtualizer.getVirtualItems()

  return (
    <div className="chat-list-wrap">
      <div className="chat-list" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-list-inner" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => (
            <div
              key={item.key}
              className="chat-list-row"
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <MessageRow chatId={chatId} messageId={ids[item.index]} />
            </div>
          ))}
        </div>
      </div>

      {showJump ? (
        <button
          type="button"
          className="chat-jump"
          onClick={() => {
            follow.current = true
            setShowJump(false)
            scrollToBottom()
          }}
        >
          ↓ {t('chat.jumpToLatest')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * One row.
 *
 * The subscription is per message on purpose: the list hands down an id, not a
 * message, so a delta that touches message 3 wakes exactly one of these.
 */
const MessageRow = memo(function MessageRow({
  chatId,
  messageId,
}: {
  chatId: ChatId
  messageId: ChatMessageId
}): ReactElement | null {
  const message = useChatMessage(chatId, messageId)
  if (!message) return null
  return <MessageItem message={message} />
})
