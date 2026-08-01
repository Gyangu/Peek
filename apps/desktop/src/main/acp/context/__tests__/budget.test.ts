import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_CONTEXT_BUDGET,
  clampValue,
  describeTruncation,
  estimateTokens,
  planRowFit,
  type ContextBudget,
  type TruncationNotice,
} from '../budget'

/* ==================================================================
 * The budget exists to stop one click from spending a context window,
 * and the rule it enforces is "never truncate silently". Every test
 * below is really the same assertion from a different angle: the
 * output tells you what it left out.
 * ================================================================== */

describe('estimateTokens', () => {
  it('is monotonic in length', () => {
    assert.ok(estimateTokens('aaaa') <= estimateTokens('aaaaaaaa'))
  })

  it('lands near 3 characters per token on CSV, the density it is tuned for', () => {
    const csv = Array.from({ length: 100 }, (_v, i) => `${i},"SKU-000${i}","emea",4293,"ok"`).join('\n')
    const ratio = csv.length / estimateTokens(csv)
    assert.ok(ratio > 2 && ratio < 4, `expected ~3 chars/token, got ${ratio.toFixed(2)}`)
  })

  it('charges punctuation more than prose, since delimiters merge poorly', () => {
    const prose = 'the quick brown fox jumps over'.slice(0, 24)
    const delim = '","","","","","","","'.slice(0, 24)
    assert.ok(estimateTokens(delim) > estimateTokens(prose))
  })

  it('charges non-ASCII text per character rather than per four', () => {
    // CJK is roughly one token per character; undercounting it is how a budget
    // silently overruns on a database full of Chinese text.
    assert.ok(estimateTokens('数据库连接查询') >= 7)
  })

  it('errs high rather than low', () => {
    // The asymmetry is the design: overrunning loses the prompt, over-trimming
    // costs a few rows.
    const text = 'SELECT * FROM public.orders WHERE region IS NULL'
    assert.ok(estimateTokens(text) >= text.length / 4)
  })

  it('returns zero for an empty string', () => {
    assert.equal(estimateTokens(''), 0)
  })
})

describe('planRowFit', () => {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, maxRows: 100, maxTokensPerAttachment: 1_000 }
  /** ~40 chars/row ≈ 13 tokens/row, so ~75 rows fit in 1,000 tokens. */
  const render = (n: number): string =>
    Array.from({ length: n }, (_v, i) => `${i},"SKU-000${i}","emea",4293,"ok"`).join('\n')

  it('reports no notice when everything fits', () => {
    const plan = planRowFit({ available: 10, total: 10, sourceTruncated: false, render, budget })
    assert.equal(plan.rows, 10)
    assert.equal(plan.notice, null)
  })

  it('applies the row cap and says so', () => {
    const cheap = (n: number): string => 'x'.repeat(n)
    const plan = planRowFit({ available: 5_000, total: 5_000, sourceTruncated: false, render: cheap, budget })
    assert.equal(plan.rows, 100)
    assert.equal(plan.notice?.reason, 'rowCap')
    assert.equal(plan.notice?.included, 100)
    assert.equal(plan.notice?.total, 5_000)
  })

  it('cuts to the token budget and reports the real included count', () => {
    const plan = planRowFit({ available: 100, total: 100, sourceTruncated: false, render, budget })
    assert.ok(plan.rows > 0, 'must not give up entirely')
    assert.ok(plan.rows < 100, 'must actually cut')
    assert.equal(plan.notice?.reason, 'tokenBudget')
    assert.equal(plan.notice?.included, plan.rows)
    // The promise of the notice: what it says is included really is included.
    assert.ok(estimateTokens(render(plan.rows)) <= budget.maxTokensPerAttachment)
  })

  it('reports sourceTruncated even when everything available was rendered', () => {
    // "We sent you all 40 rows we have" and "the query only returned 40 of
    // 12,345" call for different follow-ups, so this must not be silent.
    const plan = planRowFit({ available: 40, total: 12_345, sourceTruncated: true, render, budget })
    assert.equal(plan.rows, 40)
    assert.equal(plan.notice?.reason, 'sourceTruncated')
  })

  it('prefers sourceTruncated over peek’s own reasons when both apply', () => {
    const cheap = (n: number): string => 'x'.repeat(n)
    const plan = planRowFit({ available: 5_000, total: null, sourceTruncated: true, render: cheap, budget })
    assert.equal(plan.notice?.reason, 'sourceTruncated')
  })

  it('carries an unknown total through as null rather than inventing one', () => {
    const plan = planRowFit({ available: 500, total: null, sourceTruncated: false, render: (n) => 'x'.repeat(n), budget })
    assert.equal(plan.notice?.total, null)
  })

  it('handles an empty result without truncating', () => {
    const plan = planRowFit({ available: 0, total: 0, sourceTruncated: false, render, budget })
    assert.equal(plan.rows, 0)
    assert.equal(plan.notice, null)
  })

  it('degrades to zero rows rather than overrunning when a single row is too big', () => {
    const huge = (n: number): string => 'x'.repeat(n * 100_000)
    const plan = planRowFit({ available: 4, total: 4, sourceTruncated: false, render: huge, budget })
    assert.equal(plan.rows, 0)
    assert.equal(plan.notice?.reason, 'tokenBudget')
  })
})

describe('clampValue', () => {
  const budget: ContextBudget = { ...DEFAULT_CONTEXT_BUDGET, maxValueChars: 10 }

  it('leaves a short value untouched and unannotated', () => {
    const out = clampValue('short', budget)
    assert.equal(out.text, 'short')
    assert.equal(out.notice, null)
  })

  it('cuts to the cap and reports both counts', () => {
    const out = clampValue('a'.repeat(50), budget)
    assert.equal(out.text.length, 10)
    assert.equal(out.notice?.unit, 'characters')
    assert.equal(out.notice?.included, 10)
    assert.equal(out.notice?.total, 50)
    assert.equal(out.notice?.reason, 'valueCap')
  })

  it('does not cut a value exactly at the cap', () => {
    assert.equal(clampValue('a'.repeat(10), budget).notice, null)
  })
})

describe('describeTruncation', () => {
  const base: TruncationNotice = { unit: 'rows', included: 100, total: 12_345, reason: 'rowCap' }

  it('always states both the included and the total count', () => {
    const text = describeTruncation(base)
    assert.ok(text.includes('100'))
    assert.ok(text.includes('12,345'))
  })

  it('tells the model the data itself is incomplete, not just trimmed', () => {
    const text = describeTruncation({ ...base, reason: 'sourceTruncated' })
    assert.ok(/incomplete/i.test(text))
    assert.ok(/re-run/i.test(text), 'must name the recovery action')
  })

  it('says the total is unknown rather than printing null', () => {
    const text = describeTruncation({ ...base, total: null })
    assert.ok(!text.includes('null'))
    assert.ok(/unknown/i.test(text))
  })

  it('has a distinct sentence for every reason', () => {
    const reasons = ['rowCap', 'tokenBudget', 'valueCap', 'sourceTruncated', 'promptBudget'] as const
    const texts = reasons.map((reason) => describeTruncation({ ...base, reason }))
    assert.equal(new Set(texts).size, reasons.length)
  })
})
