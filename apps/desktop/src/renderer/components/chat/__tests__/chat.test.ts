import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CHAT_PERMISSION_MODES,
  applyChatDeltaToMessages,
  makePanel,
  placeholdersOf,
  transcriptToDeltas,
} from '@peek/core'
import type {
  AttachmentId,
  ChatAttachment,
  ChatDelta,
  ChatId,
  ChatMessage,
  ChatMessageId,
  ConnId,
  PanelId,
  PermissionOption,
  ResultId,
  SplitId,
  ToolCallRecord,
  ViewId,
  ViewState,
  Workspace,
} from '@peek/core'
import { defaultChatViewId, toAttachmentSpec } from '../contextPort'
import { highlight, normalizeLang } from '../highlight'
import { chat as chatEn } from '../../../i18n/messages/en/chat'
import { chat as chatZhCN } from '../../../i18n/messages/zh-CN/chat'
import { parseInline, parseMarkdown, type MdInline } from '../mdParser'
import {
  isPermissiveMode,
  needsModeConfirmation,
  orderPermissionOptions,
  permissionButtonVariant,
} from '../permissionOptions'
import {
  extractPlan,
  parseToolTitle,
  rawOutputText,
  summarizeToolInput,
  toolResultText,
} from '../toolCalls'
import { composerDisabled, strandedOnSnapshot, transcriptState } from '../panelState'
import {
  applyChatDelta,
  applyChatDeltas,
  coalesce,
  forgetChat,
  readChatMessages,
  setChatTranscript,
  useTranscriptStore,
} from '../transcriptStore'

const CHAT = 'chat_test' as ChatId
const M1 = 'msg_1' as ChatMessageId

function resetStore(): void {
  useTranscriptStore.setState({ chats: {}, channelReady: false })
}

function agentMessage(id: ChatMessageId): ChatMessage {
  return { id, role: 'agent', blocks: [], createdAt: 0, complete: false }
}

/** The plain text of an inline tree, so a test can assert nothing was cut. */
function flatten(nodes: readonly MdInline[]): string {
  return nodes
    .map((n) => (n.type === 'text' || n.type === 'code' ? n.text : flatten(n.children)))
    .join('')
}

/* ================================================================== */
/* Markdown                                                            */
/* ================================================================== */

test('markdown: an unterminated fence still renders as code', () => {
  // The streaming case: the closing fence has not arrived yet. Losing the block
  // (or throwing) would make code flicker in and out while the agent writes it.
  const blocks = parseMarkdown('```sql\nselect 1')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'code')
  assert.deepEqual(blocks[0], { type: 'code', lang: 'sql', text: 'select 1', closed: false })
})

test('markdown: a closed fence is marked closed and keeps its language', () => {
  const blocks = parseMarkdown('before\n\n```json\n{"a":1}\n```\n\nafter')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['paragraph', 'code', 'paragraph'],
  )
  const code = blocks[1]
  assert.ok(code?.type === 'code')
  assert.equal(code.lang, 'json')
  assert.equal(code.closed, true)
  assert.equal(code.text, '{"a":1}')
})

test('markdown: a pipe table survives, since attachments come back as one', () => {
  // `AttachmentPayload.text` is Markdown by contract, so every result set the
  // user pins is echoed by the model as a table.
  const blocks = parseMarkdown('| city | revenue |\n|---|--:|\n| Osaka | 4120 |\n| Lisbon | 9987 |')
  const table = blocks[0]
  assert.ok(table?.type === 'table')
  assert.equal(table.head.length, 2)
  assert.equal(table.rows.length, 2)
  assert.deepEqual(table.align, [null, 'right'])
})

test('markdown: a header with no rows is still a table (mid-stream)', () => {
  const blocks = parseMarkdown('| a | b |\n| --- | --- |')
  assert.ok(blocks[0]?.type === 'table')
  assert.equal(blocks[0].rows.length, 0)
})

test('markdown: task list items carry their checked state', () => {
  const blocks = parseMarkdown('- [x] done\n- [ ] todo')
  const list = blocks[0]
  assert.ok(list?.type === 'list')
  assert.deepEqual(
    list.items.map((i) => i.checked),
    [true, false],
  )
})

test('markdown: an ordered list keeps its start number', () => {
  const blocks = parseMarkdown('3. third\n4. fourth')
  const list = blocks[0]
  assert.ok(list?.type === 'list')
  assert.equal(list.ordered, true)
  assert.equal(list.start, 3)
  assert.equal(list.items.length, 2)
})

test('markdown: a flush-left paragraph after a list is its own block, uncut', () => {
  // The regression this pins down: `indentWidth` was handed whole lines rather
  // than their leading whitespace, so every non-blank line measured as deeply
  // indented. The list never ended, and the continuation branch then sliced
  // `baseIndent + 2` characters off text that had no such indent — "Put
  // together:" reached the screen as "t together:".
  const blocks = parseMarkdown('4. **A distinct thing** — one, two.\n\nPut together: a single burst.')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['list', 'paragraph'],
  )
  const para = blocks[1]
  assert.ok(para?.type === 'paragraph')
  assert.equal(flatten(para.inline), 'Put together: a single burst.')
})

test('markdown: a bullet list ends at a blank line too', () => {
  const blocks = parseMarkdown('- one\n- two\n\nVerbatim id/name pairs:')
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['list', 'paragraph'],
  )
  const para = blocks[1]
  assert.ok(para?.type === 'paragraph')
  assert.equal(flatten(para.inline), 'Verbatim id/name pairs:')
})

test('markdown: a lightly indented continuation keeps every character', () => {
  // One and two spaces both used to lose leading characters, because the slice
  // width was guessed from the marker rather than measured on the line.
  for (const pad of [' ', '  ', '\t']) {
    const blocks = parseMarkdown(`- item\n${pad}continued text`)
    const list = blocks[0]
    assert.ok(list?.type === 'list', `pad ${JSON.stringify(pad)}`)
    const body = list.items[0]?.blocks[0]
    assert.ok(body?.type === 'paragraph')
    assert.equal(flatten(body.inline), 'item\ncontinued text', `pad ${JSON.stringify(pad)}`)
  }
})

test('inline: a code span wins over the emphasis inside it', () => {
  const nodes = parseInline('use `a ** b` here')
  assert.deepEqual(
    nodes.map((n) => n.type),
    ['text', 'code', 'text'],
  )
  assert.equal(nodes[1]?.type === 'code' && nodes[1].text, 'a ** b')
})

test('inline: an unmatched delimiter stays literal', () => {
  // Every frame of a streaming bold run passes through this state.
  assert.deepEqual(parseInline('**half written'), [{ type: 'text', text: '**half written' }])
})

test('inline: snake_case is not emphasis', () => {
  const nodes = parseInline('column_name_here')
  assert.deepEqual(nodes, [{ type: 'text', text: 'column_name_here' }])
})

test('inline: a link keeps its href but is not an anchor downstream', () => {
  const nodes = parseInline('see [docs](https://example.test/x)')
  const link = nodes[1]
  assert.ok(link?.type === 'link')
  assert.equal(link.href, 'https://example.test/x')
})

/* ================================================================== */
/* Highlighting                                                        */
/* ================================================================== */

test('highlight: sql keywords, strings and comments are separated', () => {
  const kinds = new Set(highlight("select * from t where name = 'x' -- c", 'sql').map((t) => t.kind))
  assert.ok(kinds.has('keyword'))
  assert.ok(kinds.has('string'))
  assert.ok(kinds.has('comment'))
})

test('highlight: an unterminated string does not eat the tokenizer', () => {
  const tokens = highlight("select 'abc", 'sql')
  assert.equal(tokens.map((t) => t.text).join(''), "select 'abc")
})

test('highlight: every tokenizer is lossless', () => {
  // The rendered spans are concatenated back into the code block, so dropping a
  // character here would silently corrupt what the user reads.
  const samples: [string, ReturnType<typeof normalizeLang>][] = [
    ['select 1 from "t" /* x */', 'sql'],
    ['{"k": [1, -2.5, true, null]}', 'json'],
    ['const x = `a${b}c` // note', 'js'],
    ['ls -la | grep "$HOME" # c', 'shell'],
    ['anything at all', 'plain'],
  ]
  for (const [src, lang] of samples) {
    assert.equal(
      highlight(src, lang)
        .map((t) => t.text)
        .join(''),
      src,
      lang,
    )
  }
})

test('highlight: json keys are told apart from string values', () => {
  const tokens = highlight('{"key": "value"}', 'json')
  assert.equal(tokens.find((t) => t.text === '"key"')?.kind, 'type')
  assert.equal(tokens.find((t) => t.text === '"value"')?.kind, 'string')
})

test('normalizeLang maps the aliases an agent actually writes', () => {
  assert.equal(normalizeLang('PostgreSQL'), 'sql')
  assert.equal(normalizeLang('tsx'), 'js')
  assert.equal(normalizeLang('brainfuck'), 'plain')
})

/* ================================================================== */
/* Tool calls                                                          */
/* ================================================================== */

test('parseToolTitle: peek tools are recognised and split', () => {
  const parsed = parseToolTitle('mcp__peek__open_view')
  assert.deepEqual(parsed, {
    server: 'peek',
    tool: 'open_view',
    isPeek: true,
    mutatesWorkspace: true,
    isToolSearch: false,
  })
})

test('parseToolTitle: a peek read tool does not claim to have changed the window', () => {
  const parsed = parseToolTitle('mcp__peek__read_workspace')
  assert.equal(parsed.isPeek, true)
  assert.equal(parsed.mutatesWorkspace, false)
})

test('parseToolTitle: another server is never mistaken for peek', () => {
  const parsed = parseToolTitle('mcp__github__open_view')
  assert.equal(parsed.server, 'github')
  assert.equal(parsed.isPeek, false)
  assert.equal(parsed.mutatesWorkspace, false)
})

test('parseToolTitle: a built-in tool has no server, and ToolSearch is flagged', () => {
  assert.equal(parseToolTitle('Read').server, null)
  assert.equal(parseToolTitle('ToolSearch').isToolSearch, true)
  assert.equal(parseToolTitle('mcp__peek__read_workspace').isToolSearch, false)
})

test('summarizeToolInput survives the empty object every tool_call starts with', () => {
  assert.equal(summarizeToolInput({}), '')
  assert.equal(summarizeToolInput(undefined), '')
  assert.equal(summarizeToolInput({ withLayoutTree: true }), 'withLayoutTree: true')
})

test('summarizeToolInput clips, and says so', () => {
  const out = summarizeToolInput({ text: 'x'.repeat(400) }, 40)
  assert.equal(out.length, 40)
  assert.ok(out.endsWith('…'))
})

test('rawOutputText reads the array shape MCP tools actually return', () => {
  // Typing this field as a record is precisely the bug that made an older ACP
  // client drop every completion notification.
  assert.equal(rawOutputText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(rawOutputText('plain'), 'plain')
  assert.equal(rawOutputText(undefined), '')
})

test('toolResultText prefers the display content over the raw output', () => {
  const call: ToolCallRecord = {
    toolCallId: 't1',
    title: 'mcp__peek__read_workspace',
    kind: 'other',
    status: 'completed',
    content: [{ type: 'text', text: 'rendered' }],
    rawOutput: [{ type: 'text', text: 'raw' }],
    startedAt: 0,
  }
  assert.equal(toolResultText(call), 'rendered')
  assert.equal(toolResultText({ ...call, content: [] }), 'raw')
})

test('extractPlan reads a TodoWrite call and ignores everything else', () => {
  const base: ToolCallRecord = {
    toolCallId: 't2',
    title: 'TodoWrite',
    kind: 'think',
    status: 'completed',
    content: [],
    startedAt: 0,
  }
  const plan = extractPlan({
    ...base,
    rawInput: {
      todos: [
        { content: 'read schema', status: 'completed' },
        { content: 'write query', status: 'in_progress' },
        { content: 'open view', status: 'weird' },
      ],
    },
  })
  assert.deepEqual(plan, [
    { content: 'read schema', status: 'completed' },
    { content: 'write query', status: 'in_progress' },
    // An unknown status degrades to `pending` rather than dropping the row.
    { content: 'open view', status: 'pending' },
  ])
  assert.equal(extractPlan({ ...base, rawInput: {} }), null)
  assert.equal(extractPlan({ ...base, rawInput: { query: 'x' } }), null)
})

/* ================================================================== */
/* Transcript store                                                    */
/* ================================================================== */

test('store: text appends land in one growing block', () => {
  resetStore()
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'Hel' },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'lo' },
  ])
  const [message] = readChatMessages(CHAT)
  assert.deepEqual(message?.blocks, [{ type: 'text', text: 'Hello' }])
})

test('store: `order` keeps its identity while text streams', () => {
  // This is the property the whole `{ order, byId }` shape exists for: if the id
  // array were replaced per token, every message in the list would re-render.
  resetStore()
  applyChatDeltas([{ type: 'message.start', chatId: CHAT, message: agentMessage(M1) }])
  const before = useTranscriptStore.getState().chats[CHAT]?.order
  applyChatDeltas([{ type: 'text.append', chatId: CHAT, messageId: M1, text: 'x' }])
  const after = useTranscriptStore.getState().chats[CHAT]?.order
  assert.equal(before, after)
})

test('store: only the changed message gets a new object', () => {
  resetStore()
  const M2 = 'msg_2' as ChatMessageId
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'message.start', chatId: CHAT, message: agentMessage(M2) },
  ])
  const firstBefore = useTranscriptStore.getState().chats[CHAT]?.byId[M1]
  applyChatDeltas([{ type: 'text.append', chatId: CHAT, messageId: M2, text: 'x' }])
  assert.equal(useTranscriptStore.getState().chats[CHAT]?.byId[M1], firstBefore)
})

test('store: a thought after text opens its own block', () => {
  resetStore()
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'a' },
    { type: 'thought.append', chatId: CHAT, messageId: M1, text: 'hm' },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'b' },
  ])
  assert.deepEqual(readChatMessages(CHAT)[0]?.blocks, [
    { type: 'text', text: 'a' },
    { type: 'thought', text: 'hm' },
    { type: 'text', text: 'b' },
  ])
})

test('store: tool upserts merge by toolCallId, never append a duplicate', () => {
  // `tool_call_update` arrives repeatedly for the same call as its arguments
  // stream in; each one replaces the record wholesale.
  resetStore()
  const call: ToolCallRecord = {
    toolCallId: 'toolu_1',
    title: 'mcp__peek__run_query',
    kind: 'other',
    status: 'pending',
    content: [],
    startedAt: 0,
  }
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'tool.upsert', chatId: CHAT, messageId: M1, call },
    {
      type: 'tool.upsert',
      chatId: CHAT,
      messageId: M1,
      call: { ...call, status: 'completed', rawInput: { text: 'select 1' } },
    },
  ])
  const blocks = readChatMessages(CHAT)[0]?.blocks ?? []
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0]?.type === 'tool')
  assert.equal(blocks[0].call.status, 'completed')
})

test('store: a delta for an unknown message is dropped, not invented', () => {
  resetStore()
  applyChatDeltas([{ type: 'text.append', chatId: CHAT, messageId: M1, text: 'ghost' }])
  assert.deepEqual(readChatMessages(CHAT), [])
})

test('store: message.start is idempotent by id', () => {
  resetStore()
  const msg = agentMessage(M1)
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: msg },
    { type: 'message.start', chatId: CHAT, message: msg },
  ])
  assert.equal(useTranscriptStore.getState().chats[CHAT]?.order.length, 1)
})

test('store: message.end records the stop reason', () => {
  resetStore()
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'message.end', chatId: CHAT, messageId: M1, stopReason: 'cancelled' },
  ])
  const message = readChatMessages(CHAT)[0]
  assert.equal(message?.complete, true)
  assert.equal(message?.stopReason, 'cancelled')
})

test('store: reset empties the conversation', () => {
  resetStore()
  applyChatDeltas([
    { type: 'message.start', chatId: CHAT, message: agentMessage(M1) },
    { type: 'reset', chatId: CHAT },
  ])
  assert.deepEqual(readChatMessages(CHAT), [])
})

test('store: a full transcript replaces the mirror', () => {
  resetStore()
  setChatTranscript({
    chatId: CHAT,
    messages: [agentMessage(M1), { ...agentMessage('msg_9' as ChatMessageId), complete: true }],
  })
  assert.equal(readChatMessages(CHAT).length, 2)
})

test('coalesce merges adjacent appends only', () => {
  const M2 = 'msg_2' as ChatMessageId
  const deltas: ChatDelta[] = [
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'a' },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'b' },
    { type: 'thought.append', chatId: CHAT, messageId: M1, text: 'c' },
    { type: 'text.append', chatId: CHAT, messageId: M1, text: 'd' },
    { type: 'text.append', chatId: CHAT, messageId: M2, text: 'e' },
  ]
  const out = coalesce(deltas)
  assert.equal(out.length, 4)
  assert.equal(out[0]?.type === 'text.append' && out[0].text, 'ab')
  // A different message must not be folded into the previous one.
  assert.equal(out[3]?.type === 'text.append' && out[3].text, 'e')
})

/* ================================================================== */
/* Catalog parity                                                      */
/* ================================================================== */

/*
 * The chat slice used to ship its own catalog and its own `useChatT`; it is now
 * folded into `i18n/messages/{en,zh-CN}/chat.ts`, so `i18n.test.ts` checks key
 * parity across every locale automatically. These two stay because they say
 * something that check does not: the second one is chat-specific (its list of
 * deliberately-identical keys is about *these* strings), and the first is what
 * points a failure at this file rather than at a whole-catalog diff.
 */
test('i18n: the two chat catalogs agree on keys and placeholders', () => {
  const enKeys = Object.keys(chatEn).sort()
  const zhKeys = Object.keys(chatZhCN).sort()
  assert.deepEqual(zhKeys, enKeys)

  for (const key of enKeys) {
    const a = placeholdersOf(chatEn[key as keyof typeof chatEn])
    const b = placeholdersOf(chatZhCN[key as keyof typeof chatZhCN])
    assert.deepEqual([...b].sort(), [...a].sort(), key)
  }
})

test('i18n: no chat string was left in English by accident', () => {
  // Not a spell-check: it catches the copy-paste where a key is added to the
  // Chinese catalog by duplicating the English value.
  // Proper nouns and pure notation are identical in both catalogs by design.
  const shared = new Set([
    'chat.usage',
    'chat.plan.progress',
    'chat.tool.elapsed',
    'chat.role.agent',
  ])
  for (const [key, value] of Object.entries(chatEn)) {
    if (shared.has(key) || typeof value !== 'string') continue
    const zh = chatZhCN[key as keyof typeof chatZhCN]
    if (typeof zh !== 'string') continue
    assert.notEqual(zh, value, key)
  }
})

/* ================================================================== */
/* Shape of the .tsx files                                             */
/*                                                                     */
/* node's type stripper does not compile JSX, so components cannot be   */
/* rendered here. What is pinned instead is the handful of invariants   */
/* a refactor could delete without anything else noticing — the same    */
/* approach `error-boundary.test.ts` takes for the window boundary.     */
/* ================================================================== */

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Source with comments removed, so a rule stated in prose cannot satisfy itself. */
const code = (rel: string): string => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('composer: Enter does not send while an IME is composing', () => {
  // Without this guard the panel is unusable in Chinese and Japanese: every
  // attempt to pick a candidate fires off a half-written message.
  const composer = code('../Composer.tsx')
  assert.match(composer, /isComposing/)
  assert.match(composer, /keyCode === 229/)
  assert.match(composer, /onCompositionStart/)
  assert.match(composer, /e\.shiftKey/)
})

test('markdown: agent links never become anchors', () => {
  // Agent output is untrusted, and the renderer has no external-browser channel:
  // a live href here would either dead-end or navigate the window away from peek.
  const markdown = code('../Markdown.tsx')
  assert.doesNotMatch(markdown, /<a[\s>]/)
  assert.doesNotMatch(markdown, /href=/)
  // The link branch renders an inert span instead. This used to look for
  // `className="md-link"`; that class went in the Tailwind migration, and a
  // class name was never what made the element safe anyway. What does is the
  // shape: a span that is operable (so it is not a dead affordance) and copies
  // rather than navigates.
  assert.match(markdown, /<span\b[\s\S]*?role="button"/)
  assert.match(markdown, /copyLink\(node\.href\)/)
})

test('permission: the agent’s optionId is what goes back, not the kind', () => {
  // `optionId` and `kind` are different strings (`allow` vs `allow_once`), and
  // the agent only accepts the id.
  const prompt = code('../PermissionPrompt.tsx')
  assert.match(prompt, /respondPermission\(viewId, option\.optionId, permission\.requestId\)/)
})

test('an agent crash does not lock the composer', () => {
  // The recoverable state that used to be terminal: `agentStatus === 'error'`
  // disabled the input, and nothing in the UI could ever move it back — so the
  // only escape was "Clear", which throws the conversation away, while peek's own
  // toast promises it is preserved. Sending is the retry; the box has to take one.
  const view = code('../ChatView.tsx')
  const notReady = /const notReady =([^\n]*(?:\n(?!\s*const)[^\n]*)*)/.exec(view)?.[1] ?? ''
  assert.notEqual(notReady, '', 'notReady is gone; this rule needs rewriting against whatever replaced it')
  assert.doesNotMatch(notReady, /'error'/, 'a crashed agent must not disable the composer')
  assert.match(view, /agentStatus === 'starting'/)
  // And the user is told what to do about it.
  assert.match(view, /chat\.retry\.hint/)
})

test('a conversation being replayed disables the composer without claiming a turn', () => {
  // `loading` is the state a view opened from the session list sits in while the
  // agent replays its transcript. Two things have to be true at once and they
  // pull in opposite directions: the box must not accept a message yet (the
  // session is not up), and no stop button may appear (there is no turn to
  // stop). Grouping it with `starting` gets both; grouping it with `streaming`
  // would get neither.
  const view = code('../ChatView.tsx')
  const notReady = /const notReady =([^\n]*(?:\n(?!\s*const)[^\n]*)*)/.exec(view)?.[1] ?? ''
  assert.match(notReady, /'loading'/, 'a replaying conversation must not take a message yet')
  const busy = /const busy =([^\n]*)/.exec(view)?.[1] ?? ''
  assert.doesNotMatch(busy, /'loading'/, 'and must not show a stop button for a turn that does not exist')
})

test('every agent status the contract declares has something to say in both locales', () => {
  // The failure this catches is silent: a new `ChatAgentStatus` member renders as
  // its own key, or as nothing, and only in the state that is hardest to
  // reproduce. `statusKey` is exhaustive by type; the catalogs are not.
  const statuses = /export type ChatAgentStatus =([\s\S]*?)\n\n/.exec(
    src('../../../../../../../packages/core/src/chat.ts'),
  )?.[1]
  assert.ok(statuses, 'ChatAgentStatus is no longer a plain union; this rule needs rewriting')
  const members = [...statuses.matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  assert.ok(members.length >= 7, `expected the full union, found ${members.join(', ')}`)
  for (const member of members) {
    assert.ok(`chat.status.${member}` in chatEn, `en has no wording for status ${member}`)
    assert.ok(`chat.status.${member}` in chatZhCN, `zh-CN has no wording for status ${member}`)
  }
})

test('the panel writes no state of its own', () => {
  // Every mutation is a Command. The only exception is the draft in Composer,
  // which is not state until it is sent.
  for (const file of [
    '../ChatView.tsx',
    '../AttachmentBar.tsx',
    '../PermissionPrompt.tsx',
    '../MessageList.tsx',
    '../MessageItem.tsx',
    '../ToolCallCard.tsx',
  ]) {
    assert.doesNotMatch(code(file), /useWorkspaceStore.setState/, file)
  }
})

/* ================================================================== */
/* The context-actions port                                            */
/* ================================================================== */

test('toAttachmentSpec drops the provisional id and keeps everything else', () => {
  // Two processes minting ids for the same object is how a detach ends up
  // targeting something that is not there. Main mints; the renderer does not.
  const attachment: ChatAttachment = {
    id: 'att_1' as AttachmentId,
    label: 'orders · 3 rows',
    kind: 'rows',
    viewId: 'view_1' as ViewId,
    resultId: 'res_1' as ResultId,
    rowIndexes: [0, 1, 2],
  }
  const spec = toAttachmentSpec(attachment)
  assert.deepEqual(spec, {
    label: 'orders · 3 rows',
    kind: 'rows',
    viewId: 'view_1',
    resultId: 'res_1',
    rowIndexes: [0, 1, 2],
  })
  assert.equal('id' in spec, false)
})

test('defaultChatViewId prefers the focused panel, then a visible chat, then any', () => {
  const chatView = (id: string): ViewState => ({
    id: id as ViewId,
    kind: 'chat',
    status: 'ready',
    chatId: 'c' as ChatId,
    agentSessionId: null,
    agentStatus: 'ready',
    permissionMode: 'default',
    streamingMessageId: null,
    messageCount: 0,
    attachments: [],
  })
  const tableView = (id: string): ViewState => ({
    id: id as ViewId,
    kind: 'table',
    status: 'ready',
    connId: 'conn_1' as ConnId,
    ref: { kind: 'relation', schema: 'public', name: 't' },
    page: { offset: 0, limit: 100 },
  })

  const left = makePanel('p_left' as PanelId, ['v_table' as ViewId, 'v_chat_bg' as ViewId], 'v_table' as ViewId)
  const right = makePanel('p_right' as PanelId, ['v_chat_vis' as ViewId], 'v_chat_vis' as ViewId)
  const ws: Workspace = {
    rev: 1,
    connections: {},
    layout: { type: 'split', id: 's1' as SplitId, dir: 'row', ratio: [0.5, 0.5], children: [left, right] },
    views: {
      ['v_table' as ViewId]: tableView('v_table'),
      ['v_chat_bg' as ViewId]: chatView('v_chat_bg'),
      ['v_chat_vis' as ViewId]: chatView('v_chat_vis'),
    },
    results: {},
    focusedPanel: 'p_right' as PanelId,
  }

  // 1. the focused panel's active view is a chat
  assert.equal(defaultChatViewId(ws), 'v_chat_vis')

  // 2. focus moves to a panel showing a table: fall through to the visible chat
  assert.equal(defaultChatViewId({ ...ws, focusedPanel: 'p_left' as PanelId }), 'v_chat_vis')

  // 3. only a background tab holds a chat
  const onlyBackground: Workspace = {
    ...ws,
    layout: makePanel('p_left' as PanelId, ['v_table' as ViewId, 'v_chat_bg' as ViewId], 'v_table' as ViewId),
    focusedPanel: 'p_left' as PanelId,
  }
  assert.equal(defaultChatViewId(onlyBackground), 'v_chat_bg')

  // 4. no chat open at all — the menus offer "open a chat" instead of failing
  assert.equal(
    defaultChatViewId({
      ...ws,
      layout: makePanel('p_left' as PanelId, ['v_table' as ViewId], 'v_table' as ViewId),
      focusedPanel: 'p_left' as PanelId,
    }),
    null,
  )
  assert.equal(defaultChatViewId(null), null)
})

/* ==================================================================
 * The permission gate's presentation.
 *
 * This is the one surface in peek where a wrong default is not a cosmetic
 * problem: it is the only thing standing between an agent and a database. The
 * assertions below are about *emphasis and order*, which is exactly the kind of
 * thing that drifts back silently during an unrelated redesign.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.6.
 * ================================================================== */

const OPTIONS: PermissionOption[] = [
  { optionId: 'a', name: 'Yes', kind: 'allow_once' },
  { optionId: 'b', name: 'Yes, always', kind: 'allow_always' },
  { optionId: 'c', name: 'No', kind: 'reject_once' },
  { optionId: 'd', name: 'No, never', kind: 'reject_always' },
]

test('no permission answer is the primary button', () => {
  // The whole point. `allow_once` carried `.primary` — the brightest control on
  // screen — while rejecting was the quietest, which is a thumb on the scale.
  // Moving the emphasis to reject would be the same mistake pointed the other
  // way: it manufactures confirmation fatigue.
  for (const option of OPTIONS) {
    assert.notEqual(permissionButtonVariant(option), 'primary', `${option.kind} must not be the primary button`)
  }
  assert.equal(permissionButtonVariant(OPTIONS[0]), 'default', 'allow_once is a plain button')
  assert.equal(permissionButtonVariant(OPTIONS[2]), 'danger', 'reject reads as the negative answer')
})

test('the answer that outlives this call is the one that is marked', () => {
  // `allow_always` is the only option that changes anything beyond this single
  // call, so it is the only one that gets a mark of its own.
  //
  // `caution`, not `danger`: granting a standing permission destroys nothing,
  // it stops asking. Keeping the two apart is what lets a reject and an
  // allow-always sit side by side in the same prompt and still read as
  // different questions.
  assert.equal(permissionButtonVariant(OPTIONS[1]), 'caution')
  assert.equal(permissionButtonVariant(OPTIONS[3]), 'danger', 'reject_always is still a rejection')
})

test('one-shot answers come before the ones that change future behaviour', () => {
  const ordered = orderPermissionOptions([OPTIONS[1], OPTIONS[3], OPTIONS[0], OPTIONS[2]])
  assert.deepEqual(
    ordered.map((o) => o.kind),
    ['allow_once', 'reject_once', 'allow_always', 'reject_always'],
  )
})

test('an option kind this build does not know is still offered, at the end', () => {
  // Refusing to draw it would leave a request the user cannot answer at all.
  const exotic = { optionId: 'e', name: 'Escalate', kind: 'escalate' } as unknown as PermissionOption
  const ordered = orderPermissionOptions([exotic, OPTIONS[0]])
  assert.deepEqual(
    ordered.map((o) => o.optionId),
    ['a', 'e'],
  )
  assert.equal(permissionButtonVariant(exotic), 'default')
})

test('every move into a permissive mode is confirmed, including between them', () => {
  assert.equal(needsModeConfirmation('dontAsk', 'default'), true)
  assert.equal(needsModeConfirmation('bypassPermissions', 'default'), true)
  // Not the same authority: having already turned the asking off is not consent
  // to turn something else off as well.
  assert.equal(needsModeConfirmation('bypassPermissions', 'dontAsk'), true)
  assert.equal(needsModeConfirmation('dontAsk', 'bypassPermissions'), true)
})

test('restoring an approval gate never asks for confirmation', () => {
  for (const safe of ['default', 'auto', 'plan', 'acceptEdits'] as const) {
    assert.equal(needsModeConfirmation(safe, 'bypassPermissions'), false)
  }
  // Re-selecting the mode you are already in is not a change at all.
  assert.equal(needsModeConfirmation('dontAsk', 'dontAsk'), false)
})

test('exactly the two documented modes are treated as permissive', () => {
  const permissive = CHAT_PERMISSION_MODES.filter(isPermissiveMode)
  assert.deepEqual(permissive, ['dontAsk', 'bypassPermissions'])
})

/* ------------------------------------------------------------------ */
/* The two projections of one delta stream                             */
/* ------------------------------------------------------------------ */

/**
 * The renderer folds deltas into `{ order, byId }`; main folds the same deltas
 * into a flat `ChatMessage[]` (`applyChatDeltaToMessages`, in core). Two shapes
 * because they have two jobs — the index is what stops a streamed token from
 * re-rendering the whole list, and a file wants a list, not an index — but one
 * set of rules, and nothing enforces that except this.
 *
 * See the note on `applyChatDeltaToMessages` for why the duplicate was chosen
 * over giving one of the two callers the wrong data structure.
 */
const PROJECTION_FIXTURE: ChatDelta[] = (() => {
  const chatId = 'chat_p' as ChatId
  const user = 'm_user' as ChatMessageId
  const agent = 'm_agent' as ChatMessageId
  const call: ToolCallRecord = {
    toolCallId: 'call_1',
    title: 'mcp__peek__read_workspace',
    kind: 'other',
    status: 'pending',
    rawInput: {},
    content: [],
    startedAt: 1,
  }
  return [
    {
      type: 'message.start',
      chatId,
      message: { id: user, role: 'user', blocks: [{ type: 'text', text: 'how many?' }], createdAt: 1, complete: true },
    },
    { type: 'message.end', chatId, messageId: user, stopReason: 'end_turn' },
    {
      type: 'message.start',
      chatId,
      message: { id: agent, role: 'agent', blocks: [], createdAt: 2, complete: false },
    },
    { type: 'thought.append', chatId, messageId: agent, text: 'counting' },
    { type: 'thought.append', chatId, messageId: agent, text: '…' },
    { type: 'text.append', chatId, messageId: agent, text: 'Four' },
    { type: 'text.append', chatId, messageId: agent, text: ' tables.' },
    { type: 'tool.upsert', chatId, messageId: agent, call },
    { type: 'tool.upsert', chatId, messageId: agent, call: { ...call, status: 'completed', endedAt: 3 } },
    // A delta naming a message nobody started: both sides must drop it rather
    // than invent a placeholder.
    { type: 'text.append', chatId, messageId: 'm_ghost' as ChatMessageId, text: 'nobody sent this' },
    // Re-announcing a message replaces it; it must not appear twice.
    {
      type: 'message.start',
      chatId,
      message: { id: user, role: 'user', blocks: [{ type: 'text', text: 'how many?' }], createdAt: 1, complete: true },
    },
    { type: 'message.end', chatId, messageId: agent, stopReason: 'end_turn' },
  ]
})()

test('main’s transcript projection and the renderer’s mirror agree, delta for delta', () => {
  const chatId = 'chat_p' as ChatId
  let mine: ChatMessage[] = []
  for (const delta of PROJECTION_FIXTURE) {
    applyChatDelta(delta)
    mine = applyChatDeltaToMessages(mine, delta)

    const slice = useTranscriptStore.getState().chats[chatId]
    const theirs = (slice?.order ?? []).map((id) => slice?.byId[id])
    // Checked after *every* delta, not just at the end: a difference that
    // appears mid-stream and heals would be invisible to a final comparison,
    // and mid-stream is exactly when main decides whether to write to disk.
    assert.deepEqual(mine, theirs)
  }
  assert.equal(mine.length, 2)
  forgetChat(chatId)
})

test('a stored transcript replays into the same thing it was', () => {
  const chatId = 'chat_r' as ChatId
  let built: ChatMessage[] = []
  for (const delta of PROJECTION_FIXTURE) {
    built = applyChatDeltaToMessages(built, { ...delta, chatId } as ChatDelta)
  }

  // This is the whole restore path: `transcriptToDeltas` is what a reloaded
  // window receives, and it has to reconstruct the conversation exactly — a
  // finished message carries its blocks, so no appends are needed and none are
  // sent.
  for (const delta of transcriptToDeltas(chatId, built)) applyChatDelta(delta)
  const slice = useTranscriptStore.getState().chats[chatId]
  assert.deepEqual((slice?.order ?? []).map((id) => slice?.byId[id]), built)

  // And twice, because a mirror that is not empty must not double up.
  for (const delta of transcriptToDeltas(chatId, built)) applyChatDelta(delta)
  const again = useTranscriptStore.getState().chats[chatId]
  assert.deepEqual((again?.order ?? []).map((id) => again?.byId[id]), built)
  forgetChat(chatId)
})

test('reset clears the flat projection the same way it clears the mirror', () => {
  const chatId = 'chat_z' as ChatId
  let mine: ChatMessage[] = []
  for (const delta of PROJECTION_FIXTURE) mine = applyChatDeltaToMessages(mine, delta)
  assert.equal(mine.length, 2)
  mine = applyChatDeltaToMessages(mine, { type: 'reset', chatId })
  assert.deepEqual(mine, [])
})

/* ------------------------------------------------------------------ */
/* What the transcript area shows                                      */
/* ------------------------------------------------------------------ */

// The regression lock for the bug in
// `design/2026-08-06-opening-a-stored-conversation.md` §1.2: a conversation
// being fetched from the agent rendered the *new conversation* invitation, which
// reads as "this conversation is gone" rather than "this is on its way".
test('a conversation being loaded is never mistaken for an empty one', () => {
  assert.equal(transcriptState('loading', 0), 'loading')
})

// The other half, and the reason this cannot be "always show the loading state
// when the mirror is empty": a genuinely empty conversation still gets the
// invitation to type.
test('an idle conversation with nothing in it still invites a first message', () => {
  assert.equal(transcriptState('idle', 0), 'empty')
  assert.equal(transcriptState('ready', 0), 'empty')
})

// Bringing a *new* conversation up is not fetching anything, so the invitation
// is right there too — the empty state is not missing information, it is the
// information.
test('bringing up a new conversation keeps the invitation', () => {
  assert.equal(transcriptState('starting', 0), 'empty')
  assert.equal(transcriptState('authenticating', 0), 'empty')
})

// The ordering half of the rule, and the one that is easy to get backwards. A
// replay emits its deltas *before* the status patch that ends the load, so a
// state machine that checked `loading` first would blank an arrived transcript
// for a frame on every single load.
test('messages that have arrived win over a status that has not caught up', () => {
  assert.equal(transcriptState('loading', 1), 'messages')
  assert.equal(transcriptState('streaming', 3), 'messages')
})

/* ------------------------------------------------------------------ */
/* The snapshot that could not be replaced                             */
/* ------------------------------------------------------------------ */

/*
 * `design/2026-08-06-opening-a-stored-conversation.md` §2.4, and the reason it
 * is a test rather than a comment: this is the one clause of the snapshot design
 * that is a correctness rule. Everything else about a snapshot is a head start
 * on a wait; this stops a picture from being mistaken for a live conversation.
 */

test('a failed load leaves the snapshot marked as a picture, not as a conversation', () => {
  assert.equal(strandedOnSnapshot({ agentStatus: 'error', showingSnapshot: true }), true)
})

// The two near misses, which is where a rule like this actually goes wrong.
test('neither half alone strands a conversation on its snapshot', () => {
  // Still loading: the agent's copy is on its way and nothing is wrong.
  assert.equal(strandedOnSnapshot({ agentStatus: 'loading', showingSnapshot: true }), false)
  // A crashed agent with no snapshot under it: the composer must stay live,
  // because sending is what reconnects.
  assert.equal(strandedOnSnapshot({ agentStatus: 'error' }), false)
})

test('a message cannot be sent on top of a snapshot the agent never loaded', () => {
  assert.equal(composerDisabled({ agentStatus: 'error', showingSnapshot: true }), true)
})

// The regression this guards is a real one that shipped once: a composer
// disabled on `error` turns a recoverable crash into a dead panel whose only
// exit is "Clear", which throws the conversation away.
test('a crashed agent still takes a message, because sending is the reconnect', () => {
  assert.equal(composerDisabled({ agentStatus: 'error' }), false)
})

test('the composer is shut while a conversation is being fetched or a tool is waiting', () => {
  assert.equal(composerDisabled({ agentStatus: 'loading' }), true)
  assert.equal(composerDisabled({ agentStatus: 'starting' }), true)
  assert.equal(composerDisabled({ agentStatus: 'awaiting-permission' }), true)
  assert.equal(composerDisabled({ agentStatus: 'ready' }), false)
  assert.equal(composerDisabled({ agentStatus: 'idle' }), false)
})
