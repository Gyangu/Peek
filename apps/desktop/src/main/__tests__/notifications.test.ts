import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NotifyMessage, ViewId } from '@peek/core'
import { describeTurnNotice, turnNotice } from '../chat-host'
import { createAppHandlers } from '../bus/handlers/app'
import {
  createNotifier,
  unavailableNotifier,
  type NotifierWindow,
  type SystemNotifier,
  type UserNotice,
} from '../notifications'
import type { ChatViewState } from '@peek/core'

/* ==================================================================
 * Notifications — design 2026-08-15, verification §5.
 *
 * The whole feature is two decisions, and this file is one per section:
 *
 *   where does a message go   — a table over (is the window in front) ×
 *                               (does the user allow this) × (can the platform)
 *   is it worth saying at all — one transition in the agent's status machine
 *
 * Both are pure once their collaborators are injected, which is why they are
 * injected. Nothing here starts Electron; `electronSystemNotifier` is the only
 * thing that touches it and lives in a module of its own for that reason.
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

interface RaisedBanner {
  title: string
  body: string
  silent: boolean
  click(): void
}

function fakeSystem(supported = true): SystemNotifier & { raised: RaisedBanner[] } {
  const raised: RaisedBanner[] = []
  return {
    raised,
    supported: () => supported,
    create(options) {
      let handler: (() => void) | null = null
      const shown = {
        ...options,
        click: () => {
          handler?.()
        },
      }
      return {
        show: () => {
          raised.push(shown)
        },
        onClick: (h) => {
          handler = h
        },
      }
    },
  }
}

/** A window in front, unless told otherwise. Records what was done to it. */
function fakeWindow(
  state: { focused?: boolean; minimized?: boolean; visible?: boolean } = {},
): NotifierWindow & { calls: string[] } {
  const calls: string[] = []
  let { focused = true, minimized = false, visible = true } = state
  return {
    calls,
    isFocused: () => focused,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => {
      minimized = false
      calls.push('restore')
    },
    show: () => {
      visible = true
      calls.push('show')
    },
    focus: () => {
      focused = true
      calls.push('focus')
    },
  }
}

function harness<W extends NotifierWindow | null>(
  options: { window?: W; systemEnabled?: boolean; supported?: boolean } = {},
) {
  const toasts: NotifyMessage[] = []
  const activated: ViewId[] = []
  const system = fakeSystem(options.supported ?? true)
  const win = (options.window === undefined ? fakeWindow() : options.window) as W extends undefined
    ? ReturnType<typeof fakeWindow>
    : W
  const notify = createNotifier({
    toast: (message) => toasts.push(message),
    window: () => win,
    systemEnabled: () => options.systemEnabled ?? true,
    activateView: (viewId) => activated.push(viewId),
    system,
  })
  return { notify, toasts, activated, system, win }
}

/* ------------------------------------------------------------------ */
/* 1. Where a message goes                                             */
/* ------------------------------------------------------------------ */

describe('a notice reaches the user by the route that suits where they are', () => {
  it('stays inside the app while peek is the window in front', () => {
    // The case that makes the feature bearable: a banner here would cover the
    // corner of the window the user is reading.
    const h = harness({ window: fakeWindow({ focused: true }) })

    const result = h.notify({ level: 'info', message: 'Backfill finished', whenFocused: 'toast' })

    assert.deepEqual(result, { system: false, toast: true })
    assert.equal(h.system.raised.length, 0)
    assert.deepEqual(h.toasts, [{ level: 'info', message: 'Backfill finished' }])
  })

  it('raises a banner *and* leaves a toast when the user is elsewhere', () => {
    // Both, not either: the banner does the calling, and the toast is what they
    // find in the app — and in the error centre — when they come back.
    const h = harness({ window: fakeWindow({ focused: false }) })

    const result = h.notify({
      level: 'warn',
      message: 'Migration needs a decision',
      detail: 'Two rows collide on the new unique index.',
      whenFocused: 'toast',
    })

    assert.deepEqual(result, { system: true, toast: true })
    assert.equal(h.toasts.length, 1)
    assert.deepEqual(h.system.raised.map((b) => [b.title, b.body, b.silent]), [
      ['Migration needs a decision', 'Two rows collide on the new unique index.', false],
    ])
  })

  it('treats minimised and hidden as away, not only unfocused', () => {
    // Three conditions because they fail differently and mean the same thing to
    // a person. `isFocused()` alone is *nearly* right, which is the worst kind.
    for (const state of [{ minimized: true }, { visible: false }]) {
      const h = harness({ window: fakeWindow({ focused: true, ...state }) })
      h.notify({ level: 'info', message: 'done', whenFocused: 'toast' })
      assert.equal(h.system.raised.length, 1, `${JSON.stringify(state)} should count as away`)
    }
  })

  it('counts "no window at all" as away', () => {
    // Startup raises notices before `createWindow`. Somebody who cannot possibly
    // be reading a window is not reading it.
    const h = harness({ window: null })

    const result = h.notify({ level: 'error', message: 'A package refused to load', whenFocused: 'toast' })

    assert.deepEqual(result, { system: true, toast: true })
  })
})

describe('what peek decides on its own is quieter than what it was asked to say', () => {
  it('says nothing at all while the user is looking at peek', () => {
    // `whenFocused: 'nothing'` is the entire noise budget of the automatic
    // notifications: the reply is already on screen.
    const h = harness({ window: fakeWindow({ focused: true }) })

    const result = h.notify({ level: 'info', message: 'The agent has replied', whenFocused: 'nothing' })

    assert.deepEqual(result, { system: false, toast: false })
    assert.equal(h.system.raised.length, 0)
    assert.equal(h.toasts.length, 0)
  })

  it('still leaves a trace when the user was away', () => {
    // "Do not interrupt me" is not "leave no record" — the toast is what they
    // find on return.
    const h = harness({ window: fakeWindow({ focused: false }) })

    const result = h.notify({ level: 'info', message: 'The agent has replied', whenFocused: 'nothing' })

    assert.deepEqual(result, { system: true, toast: true })
  })
})

describe('the two ways a banner does not happen', () => {
  it('honours the preference, and still reports the toast that did happen', () => {
    // Reported rather than failed: a tool call that errors invites a retry, and
    // retrying is the one thing an unwanted notification must not do.
    const h = harness({ window: fakeWindow({ focused: false }), systemEnabled: false })

    const result = h.notify({ level: 'info', message: 'done', whenFocused: 'toast' })

    assert.deepEqual(result, { system: false, toast: true })
    assert.equal(h.system.raised.length, 0)
  })

  it('degrades silently on a platform that cannot show one', () => {
    const h = harness({ window: fakeWindow({ focused: false }), supported: false })

    const result = h.notify({ level: 'info', message: 'done', whenFocused: 'toast' })

    assert.deepEqual(result, { system: false, toast: true })
  })

  it('delivers nothing at all before anything is assembled, without throwing', () => {
    assert.deepEqual(unavailableNotifier({ level: 'info', message: 'x', whenFocused: 'toast' }), {
      system: false,
      toast: false,
    })
  })
})

describe('clicking a banner brings peek back', () => {
  it('restores, shows and focuses — whatever state the window was left in', () => {
    const h = harness({ window: fakeWindow({ focused: false, minimized: true, visible: false }) })
    h.notify({ level: 'info', message: 'done', whenFocused: 'toast' })

    h.system.raised[0].click()

    assert.deepEqual(h.win.calls, ['restore', 'show', 'focus'])
  })

  it('brings the named view forward as well, when the caller named one', () => {
    const h = harness({ window: fakeWindow({ focused: false }) })
    h.notify({
      level: 'info',
      message: 'The scan finished',
      focusViewId: 'view-7' as ViewId,
      whenFocused: 'toast',
    })

    h.system.raised[0].click()

    assert.deepEqual(h.activated, ['view-7'])
    // It travels on the toast too, so the in-app copy can be clicked to the
    // same place.
    assert.equal(h.toasts[0].viewId, 'view-7')
  })

  it('does not touch any view when the caller named none', () => {
    const h = harness({ window: fakeWindow({ focused: false }) })
    h.notify({ level: 'info', message: 'done', whenFocused: 'toast' })

    h.system.raised[0].click()

    assert.deepEqual(h.activated, [])
    assert.equal(h.toasts[0].viewId, undefined)
  })
})

/* ------------------------------------------------------------------ */
/* 1b. The command that carries a caller's words                       */
/* ------------------------------------------------------------------ */

describe('app.notify hands the caller straight to the outlet', () => {
  const handlerFor = (): { read: NonNullable<ReturnType<typeof createAppHandlers>['app.notify']['read']> } =>
    createAppHandlers((notice) => {
      seen.push(notice)
      return { system: true, toast: true }
    })['app.notify']
  let seen: UserNotice[] = []

  it('defaults the level, and is heard even with peek in front', () => {
    seen = []
    // `whenFocused: 'toast'` for everything that came through this command: an
    // agent chose to say something, and dropping it silently would be a lie.
    const result = handlerFor().read({} as never, { message: 'Backfill finished' })

    assert.deepEqual(seen, [{ level: 'info', message: 'Backfill finished', whenFocused: 'toast' }])
    assert.deepEqual(result, { system: true, toast: true })
  })

  it('passes the optional members only when they were given', () => {
    seen = []
    handlerFor().read(
      {} as never,
      { message: 'Careful', detail: 'Two rows collide.', level: 'warn', focusViewId: 'view-3' as ViewId },
    )

    assert.deepEqual(seen, [
      {
        level: 'warn',
        message: 'Careful',
        detail: 'Two rows collide.',
        focusViewId: 'view-3',
        whenFocused: 'toast',
      },
    ])
  })
})

/* ------------------------------------------------------------------ */
/* 2. Whether a turn is worth interrupting someone for                 */
/* ------------------------------------------------------------------ */

function chatView(over: Partial<ChatViewState> = {}): ChatViewState {
  return {
    id: 'view-1' as ViewId,
    kind: 'chat',
    status: 'ready',
    chatId: 'chat-1' as ChatViewState['chatId'],
    agentSessionId: null,
    agentStatus: 'idle',
    permissionMode: 'default',
    streamingMessageId: null,
    messageCount: 0,
    attachments: [],
    ...over,
  } as ChatViewState
}

describe('the agent announces itself on a transition, never on a state', () => {
  it('reports a turn that has just ended', () => {
    const notice = turnNotice('streaming', chatView({ agentStatus: 'idle', lastMessagePreview: '41,882 rows' }))

    assert.deepEqual(notice, { viewId: 'view-1', kind: 'replied', preview: '41,882 rows' })
  })

  it('says nothing when the turn was already over', () => {
    // The half that keeps this from firing on every patch: `ready` is where a
    // panel sits for as long as nobody types.
    assert.equal(turnNotice('idle', chatView({ agentStatus: 'idle' })), null)
    assert.equal(turnNotice('ready', chatView({ agentStatus: 'ready' })), null)
  })

  it('says nothing when a stored conversation finishes replaying', () => {
    // `loading → ready` answered nothing. A user who clicked a session in the
    // rail does not need to be told their click worked.
    assert.equal(turnNotice('loading', chatView({ agentStatus: 'ready' })), null)
  })

  it('reports a turn that stopped to ask permission', () => {
    const notice = turnNotice(
      'streaming',
      chatView({
        agentStatus: 'awaiting-permission',
        title: 'Index audit',
        pendingPermission: {
          requestId: 'r1',
          toolCallId: 't1',
          toolName: 'run_query',
          inputPreview: 'DROP …',
          options: [],
          askedAt: 0,
        },
      }),
    )

    assert.deepEqual(notice, {
      viewId: 'view-1',
      label: 'Index audit',
      kind: 'permission',
      toolName: 'run_query',
    })
  })

  it('leaves a failed turn to the panel and the error centre', () => {
    assert.equal(turnNotice('streaming', chatView({ agentStatus: 'error' })), null)
  })

  it('drops a title that is there but empty, rather than prefixing a blank', () => {
    const notice = turnNotice('streaming', chatView({ agentStatus: 'idle', title: '   ' }))

    assert.equal(notice?.label, undefined)
  })
})

describe('a turn notice read on a lock screen', () => {
  it('names the conversation when it has one', () => {
    assert.deepEqual(
      describeTurnNotice({ viewId: 'view-1' as ViewId, label: 'Index audit', kind: 'replied', preview: 'Done.' }),
      { message: 'Index audit: the agent has replied', detail: 'Done.' },
    )
  })

  it('reads as a sentence when it does not', () => {
    assert.deepEqual(describeTurnNotice({ viewId: 'view-1' as ViewId, kind: 'replied' }), {
      message: 'The agent has replied',
    })
  })

  it('names the tool that is waiting, and says so when it cannot', () => {
    assert.equal(
      describeTurnNotice({ viewId: 'view-1' as ViewId, kind: 'permission', toolName: 'run_query' }).detail,
      'run_query is waiting for permission.',
    )
    assert.equal(
      describeTurnNotice({ viewId: 'view-1' as ViewId, kind: 'permission' }).detail,
      'A tool call is waiting for permission.',
    )
  })
})
