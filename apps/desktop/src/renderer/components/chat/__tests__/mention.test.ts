import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asChatId, asConnId, asResultId, asViewId, type ViewState } from '@peek/core'
import { boundT, type TFunction } from '../../../i18n'
import { attachCandidates, attachmentIdentity } from '../attachments'
import {
  applyMention,
  atomicBackspace,
  dropMention,
  filterByMention,
  findMention,
  hasMention,
  mentionToken,
} from '../mention'

/* ==================================================================
 * The `@` in the composer.
 *
 * All of it is pure on purpose: what counts as a mention, and what the
 * draft looks like afterwards, are rules — not things to discover by
 * driving a textarea.
 * ================================================================== */

const t: TFunction = boundT('en')

describe('findMention · what opens the list', () => {
  it('finds an @ at the start of the draft', () => {
    assert.deepEqual(findMention('@ord', 4), { start: 0, end: 4, filter: 'ord' })
  })

  it('finds one after whitespace, mid-sentence', () => {
    const text = 'why is @ord'
    assert.deepEqual(findMention(text, text.length), { start: 7, end: 11, filter: 'ord' })
  })

  it('opens on the bare @, before anything is typed', () => {
    assert.deepEqual(findMention('@', 1), { start: 0, end: 1, filter: '' })
  })

  it('leaves an email address alone', () => {
    // The rule is about what precedes the @, which is why this needs no
    // special case of its own.
    assert.equal(findMention('user@example.com', 16), null)
    assert.equal(findMention('a@b', 3), null)
  })

  it('ends the mention at the first space', () => {
    assert.equal(findMention('@orders and', 11), null)
  })

  it('finds the mention the caret is in, not the last one in the text', () => {
    const text = '@one @two'
    assert.deepEqual(findMention(text, 4), { start: 0, end: 4, filter: 'one' })
  })

  it('gives up rather than scanning a pasted essay', () => {
    const long = `@${'x'.repeat(200)}`
    assert.equal(findMention(long, long.length), null)
  })
})

describe('applyMention · what the draft reads afterwards', () => {
  it('replaces the mention with the name and a trailing space', () => {
    const text = '@ord'
    const m = findMention(text, 4)
    assert.ok(m)
    assert.deepEqual(applyMention(text, m, 'public.orders'), {
      text: '@public.orders ',
      caret: 15,
    })
  })

  it('keeps the tail when the mention is mid-sentence, and adds no second space', () => {
    const text = 'why is @ord empty?'
    const m = findMention(text, 11)
    assert.ok(m)
    const out = applyMention(text, m, 'public.orders')
    assert.equal(out.text, 'why is @public.orders empty?')
    // The caret lands right after the name, before the space that was there.
    assert.equal(out.text.slice(0, out.caret), 'why is @public.orders')
  })
})

describe('mentionToken · a name that survives being read in a sentence', () => {
  it('strips whitespace so the name does not break in half', () => {
    assert.equal(mentionToken('查询 1'), '查询1')
    assert.equal(mentionToken('Query 1'), 'Query1')
  })

  it('leaves an identifier as it is', () => {
    assert.equal(mentionToken('public.orders'), 'public.orders')
  })
})

/* ==================================================================
 * The binding. A mention and its chip are one thing in two places:
 * delete either and the other goes. Everything below is what makes
 * that safe to do from a plain textarea.
 * ================================================================== */

describe('hasMention · is the draft still referring to it', () => {
  it('finds it at either end of a sentence', () => {
    assert.ok(hasMention('@public.orders is slow', 'public.orders'))
    assert.ok(hasMention('why is @public.orders slow', 'public.orders'))
  })

  it('counts trailing punctuation as the sentence, not as a different name', () => {
    assert.ok(hasMention('what about @public.orders?', 'public.orders'))
    assert.ok(hasMention('@public.orders, and orders_v2', 'public.orders'))
  })

  it('does not count a longer name that starts the same', () => {
    // The case that matters: editing `@public.orders` into `@public.orders_v2`
    // must not leave the first attachment silently staged.
    assert.equal(hasMention('@public.orders_v2', 'public.orders'), false)
  })

  it('does not count a truncated one', () => {
    assert.equal(hasMention('@public.order', 'public.orders'), false)
  })

  it('needs the @ to start a word', () => {
    assert.equal(hasMention('mail me at x@public.orders', 'public.orders'), false)
  })
})

describe('dropMention · taking the word out when the chip goes', () => {
  it('takes the trailing space with it', () => {
    assert.equal(dropMention('@public.orders is slow', 'public.orders'), 'is slow')
  })

  it('takes the leading space when there is nothing after it', () => {
    assert.equal(dropMention('why is @public.orders', 'public.orders'), 'why is')
  })

  it('keeps the punctuation, and does not leave a space in front of it', () => {
    // Nothing follows the name but a `?`, so the space that goes is the one
    // before it — a sentence must not end up reading `what about ?`.
    assert.equal(dropMention('what about @public.orders?', 'public.orders'), 'what about?')
  })

  it('removes one occurrence, not every one', () => {
    assert.equal(
      dropMention('@public.orders vs @public.orders', 'public.orders'),
      'vs @public.orders',
    )
  })
})

describe('atomicBackspace · a mention deletes whole', () => {
  const tokens = ['public.orders']

  it('takes the whole word from its end', () => {
    const text = 'why is @public.orders'
    assert.deepEqual(atomicBackspace(text, text.length, tokens), { text: 'why is ', caret: 7 })
  })

  it('takes the word and the space when the caret is past it', () => {
    const text = '@public.orders '
    assert.deepEqual(atomicBackspace(text, 15, tokens), { text: '', caret: 0 })
  })

  it('hands the key back everywhere else', () => {
    // Mid-word, and after unrelated text: the textarea does what it always does.
    assert.equal(atomicBackspace('@public.orders', 5, tokens), null)
    assert.equal(atomicBackspace('@public.orders is slow', 22, tokens), null)
  })

  it('ignores a word that was typed rather than picked', () => {
    assert.equal(atomicBackspace('@orders', 7, tokens), null)
  })
})

describe('filterByMention', () => {
  const items = [
    { token: 'public.orders', label: 'Structure of public.orders' },
    { token: 'Query1', label: 'SQL of Query 1', hint: 'select * from order_items' },
  ]

  it('returns everything for an empty filter', () => {
    assert.equal(filterByMention(items, '').length, 2)
  })

  it('matches the token, the label or the hint, case-insensitively', () => {
    assert.deepEqual(filterByMention(items, 'ORDERS').map((i) => i.token), ['public.orders'])
    assert.deepEqual(filterByMention(items, 'order_items').map((i) => i.token), ['Query1'])
  })
})

/* ================================================================== */
/* What `@` can offer                                                  */
/* ================================================================== */

const CONN = asConnId('conn_1')
const tableView: ViewState = {
  id: asViewId('view_1'),
  kind: 'table',
  status: 'ready',
  connId: CONN,
  ref: { kind: 'relation', schema: 'public', name: 'orders' },
  page: { offset: 0, limit: 200 },
  resultId: asResultId('res_1'),
}
const queryView: ViewState = {
  id: asViewId('view_2'),
  kind: 'query',
  status: 'ready',
  connId: CONN,
  text: 'select 1',
}
const chatView: ViewState = {
  id: asViewId('view_3'),
  kind: 'chat',
  status: 'ready',
  chatId: asChatId('chat_1'),
  agentSessionId: null,
  agentStatus: 'idle',
  permissionMode: 'default',
  permissionModeInherited: false,
  streamingMessageId: null,
  attachments: [],
  messageCount: 0,
}

describe('attachCandidates', () => {
  it('offers the structure of a browsed collection, alongside its result', () => {
    const kinds = attachCandidates([tableView], t).map((c) => c.spec.kind)
    assert.deepEqual(kinds, ['workspace', 'result', 'schema'])
  })

  it('names both of a table view the same way in the draft', () => {
    // Deliberate: `@public.orders` is what a person calls the table. Which of
    // the two gets sent is decided by the chip they picked, not by the word.
    const tokens = attachCandidates([tableView], t)
      .filter((c) => c.spec.kind !== 'workspace')
      .map((c) => c.token)
    assert.deepEqual(tokens, ['public.orders', 'public.orders'])
  })

  it('gives a chip a noun phrase, never the menu line', () => {
    for (const c of attachCandidates([tableView, queryView], t)) {
      assert.doesNotMatch(c.chipLabel, /^Add /, `chip label reads as an action: ${c.chipLabel}`)
      assert.doesNotMatch(c.token, /\s/u, `token has whitespace: ${c.token}`)
    }
  })

  it('skips the chat itself — attaching a conversation to itself is a loop', () => {
    assert.deepEqual(attachCandidates([chatView], t).map((c) => c.key), ['workspace'])
  })

  it('leads with the selection when a grid has one, and drops it when none', () => {
    const withCells = attachCandidates([tableView], t, {
      kind: 'cells',
      viewId: tableView.id,
      resultId: asResultId('res_1'),
      r0: 2,
      r1: 4,
      columns: ['name', 'score'],
    })
    assert.equal(withCells[0]?.key, 'selection')
    assert.match(withCells[0]?.hint ?? '', /2 cols × 3 rows/)
    assert.equal(attachCandidates([tableView], t)[0]?.key, 'workspace')
    assert.equal(attachCandidates([tableView], t, null)[0]?.key, 'workspace')
  })

  it('offers one entry for either kind of selection — they never coexist', () => {
    const rows = attachCandidates([tableView], t, {
      kind: 'rows',
      viewId: tableView.id,
      resultId: asResultId('res_1'),
      rowIndexes: [3, 9],
    })
    assert.equal(rows[0]?.spec.kind, 'rows')
    // Whole rows: the hint counts rows and says nothing about columns, because
    // none were narrowed.
    assert.match(rows[0]?.hint ?? '', /2 rows/)
    assert.doesNotMatch(rows[0]?.hint ?? '', /cols/)
  })

  it('re-identifies itself when the selection moves, so "Added" cannot go stale', () => {
    const at = (r1: number): string | undefined =>
      attachCandidates([tableView], t, {
        kind: 'cells',
        viewId: tableView.id,
        resultId: asResultId('res_1'),
        r0: 0,
        r1,
        columns: ['name'],
      })[0]?.identity
    assert.notEqual(at(1), at(2))
  })

  it('drops a selection whose view has closed', () => {
    const orphan = attachCandidates([queryView], t, {
      kind: 'rows',
      viewId: tableView.id,
      resultId: asResultId('res_1'),
      rowIndexes: [1],
    })
    assert.equal(orphan[0]?.key, 'workspace')
  })

  it('identifies a candidate the way a staged attachment identifies itself', () => {
    const [, result] = attachCandidates([tableView], t)
    assert.ok(result)
    assert.equal(
      result.identity,
      attachmentIdentity({
        id: 'att_1' as never,
        label: 'whatever',
        kind: 'result',
        viewId: tableView.id,
        resultId: asResultId('res_1'),
        maxRows: 200,
      }),
      'the same thing staged twice must be recognised, id and label aside',
    )
  })
})
