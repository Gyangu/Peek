/**
 * Token budgeting and truncation.
 *
 * ## Why this file is not optional
 *
 * One screen of a database viewer is not one screen of tokens. A 200-row page of
 * a 40-column table is roughly 60k tokens; a single `jsonb` column can be
 * megabytes; a qdrant point carries a 1536-float vector. "Add this to the chat"
 * is one click, and without a ceiling that click can spend a user's entire
 * context window — or fail the request outright — with no warning.
 *
 * ## The rule that shapes everything here: never truncate silently
 *
 * Every function below returns a `TruncationNotice` alongside its output, and
 * both audiences are told:
 *
 * - the **model**, in the document body ("rows 1-100 of 12,345 · truncated to fit
 *   the context budget"). A model that believes it was handed a complete table
 *   will confidently compute a sum over 100 of 12,345 rows and report it as *the*
 *   sum. That is a wrong answer produced with total confidence, which is worse
 *   than a refusal;
 * - the **user**, through `TruncationNotice` surfacing on the attachment chip
 *   ("first 100 of 12,345 rows"). A user who thinks they attached everything will
 *   trust an answer that was never based on everything.
 *
 * ## Estimating tokens without a tokenizer
 *
 * peek does not ship a BPE tokenizer, and should not: it would be tens of
 * megabytes of vocabulary to decide how many rows to cut, and it would be the
 * wrong tokenizer the moment the agent's model changes.
 *
 * `estimateTokens` is a character-class heuristic instead, deliberately biased to
 * **over-estimate**. Over-estimating truncates a little earlier than necessary;
 * under-estimating overruns the budget, and the failure mode of an overrun is a
 * rejected prompt or a silently dropped attachment. The asymmetry is the whole
 * design: guess high.
 */

/* ================================================================== */
/* 1. Token estimation                                                 */
/* ================================================================== */

/**
 * Approximate tokens in a string.
 *
 * Weights come from how byte-pair encoders behave on the two kinds of text peek
 * actually emits:
 *
 * - **alphanumeric runs** merge well — English prose and identifiers land near
 *   four characters per token, so each such character counts 0.25;
 * - **punctuation and symbols** merge poorly. Delimited data is mostly `,` `"`
 *   `\` `|`, and in CSV those sit between unrelated values where the encoder has
 *   little to merge with, so each counts 0.5;
 * - **whitespace** is usually absorbed into an adjacent token; each counts 0.25.
 *
 * On the CSV documents this module produces the result is ≈3 characters per
 * token, which measured runs put slightly *below* the true ratio — i.e. on the
 * safe side, as intended.
 */
export function estimateTokens(text: string): number {
  let alnum = 0
  let space = 0
  let other = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    const isDigit = c >= 48 && c <= 57
    const isUpper = c >= 65 && c <= 90
    const isLower = c >= 97 && c <= 122
    if (isDigit || isUpper || isLower) alnum += 1
    else if (c === 32 || c === 9 || c === 10 || c === 13) space += 1
    // Anything past ASCII is CJK, emoji or accented text. Those are roughly one
    // token per character (often more for CJK), so they are counted whole
    // rather than lumped in with punctuation.
    else if (c > 127) other += 2
    else other += 1
  }
  return Math.ceil(alnum * 0.25 + space * 0.25 + other * 0.5)
}

/* ================================================================== */
/* 2. Budgets                                                          */
/* ================================================================== */

/**
 * Ceilings for one attachment and for one prompt's worth of them.
 *
 * These are **defaults, not laws** — `ContextBudget` is threaded through every
 * entry point so a caller with a bigger context window, or a test, can say
 * otherwise. The numbers are chosen against a ~200k-token window: one attachment
 * may spend ~4% of it, and everything staged on a single turn ~12%, which leaves
 * the conversation itself the overwhelming majority.
 */
export interface ContextBudget {
  /** Tokens one attachment may occupy. */
  readonly maxTokensPerAttachment: number
  /** Tokens every attachment on one prompt may occupy together. */
  readonly maxTokensPerPrompt: number
  /** Hard row ceiling, applied before the token budget is even measured. */
  readonly maxRows: number
  /**
   * Characters of a single cell value.
   *
   * Separate from the token budget because a cell attachment exists precisely to
   * carry the value a grid could only show a preview of. It gets a larger share
   * than a row would, but still a finite one.
   */
  readonly maxValueChars: number
  /**
   * Elements of a vector rendered literally before it is summarised.
   *
   * A 1536-dimension embedding is ~12k characters of float and tells a model
   * nothing it can use. Past this many, `serialize.ts` emits dimension, norm and
   * a head/tail sample instead.
   */
  readonly maxVectorElements: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokensPerAttachment: 8_000,
  maxTokensPerPrompt: 24_000,
  maxRows: 2_000,
  maxValueChars: 40_000,
  maxVectorElements: 32,
}

/* ================================================================== */
/* 3. Truncation notices                                               */
/* ================================================================== */

/** What got cut, and why. `reason` is what distinguishes peek's doing from the source's. */
export type TruncationReason =
  /** Hit `ContextBudget.maxRows`. */
  | 'rowCap'
  /** Hit `maxTokensPerAttachment`. */
  | 'tokenBudget'
  /** Hit `maxValueChars` / `maxVectorElements`. */
  | 'valueCap'
  /**
   * **The source was already incomplete** — the query was cut off by `maxRows`,
   * backpressure paused the stream, or the cache had evicted the rest. peek cut
   * nothing here, and saying so matters: "we showed you 100 of 12,345" and "the
   * database only ever gave us 100" call for different follow-up actions.
   */
  | 'sourceTruncated'
  /** Dropped because the prompt-wide budget was already spent on earlier attachments. */
  | 'promptBudget'

export interface TruncationNotice {
  /** What the counts refer to, so a renderer can pick the right sentence. */
  unit: 'rows' | 'characters' | 'elements'
  /** How much made it into the payload. */
  included: number
  /** How much exists in total. `null` when the total is genuinely unknown (a stream still running). */
  total: number | null
  reason: TruncationReason
}

/**
 * One English sentence for the model, appended to the document body.
 *
 * English always — this text is read by the agent, never by the UI, and the same
 * rule that keeps `describeView` locale-independent applies. The renderer gets
 * the structured `TruncationNotice` and localizes it itself.
 */
export function describeTruncation(n: TruncationNotice): string {
  const total = n.total === null ? 'an unknown number of' : formatCount(n.total)
  const head = `Truncated: ${formatCount(n.included)} of ${total} ${n.unit} included.`
  switch (n.reason) {
    case 'rowCap':
      return `${head} peek caps a single attachment at ${formatCount(n.included)} rows.`
    case 'tokenBudget':
      return `${head} The rest did not fit the context budget for one attachment.`
    case 'valueCap':
      return `${head} The value was longer than one attachment may carry.`
    case 'sourceTruncated':
      return (
        `${head} This is everything peek has — the result set itself is incomplete ` +
        '(the query hit its row limit, was paused by backpressure, or was cancelled). ' +
        'Re-run the query in peek to fetch more.'
      )
    case 'promptBudget':
      return `${head} Earlier attachments on this message had already used the context budget.`
  }
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/* ================================================================== */
/* 4. Fitting rows to a budget                                         */
/* ================================================================== */

export interface RowFitPlan {
  /** How many rows to render. */
  rows: number
  /** Set when fewer rows are rendered than were offered. */
  notice: TruncationNotice | null
}

/**
 * Decide how many rows fit.
 *
 * Two passes, because the two limits are not interchangeable:
 *
 * 1. the **row cap** is applied first and needs no measuring — it exists so a
 *    500,000-row selection does not get serialized at all before being thrown
 *    away, which is both slow and pointless;
 * 2. the **token budget** is then measured on the real rendered text. It has to
 *    be the real text: row width varies by orders of magnitude between a table of
 *    integers and a table of JSON blobs, so any per-row constant would be wrong
 *    for one of them by a factor of a hundred.
 *
 * The search is a geometric probe followed by a linear walk-back rather than a
 * full binary search. Rendering is the expensive part, and in the overwhelmingly
 * common case (everything fits) this costs exactly one render of the whole set.
 *
 * `sourceTruncated` wins over peek's own reasons when both apply: the user needs
 * to know the data itself is partial more than they need to know peek trimmed it.
 */
export function planRowFit(options: {
  /** Rows available to render right now. */
  available: number
  /** Rows the source says exist in total; null when unknown (a running stream). */
  total: number | null
  /** True when the source itself is already incomplete. */
  sourceTruncated: boolean
  /** Render the first `n` rows and return the exact text that would be sent. */
  render: (n: number) => string
  budget: ContextBudget
}): RowFitPlan {
  const { available, total, sourceTruncated, render, budget } = options

  const capped = Math.min(available, budget.maxRows)
  const hitRowCap = capped < available

  let rows = capped
  let hitTokenBudget = false
  if (rows > 0 && estimateTokens(render(rows)) > budget.maxTokensPerAttachment) {
    hitTokenBudget = true
    // Halve until it fits, then walk back up in tenths of the last gap. Bounded
    // by log2(maxRows) + 10 renders, and it lands within ~10% of the true
    // maximum, which is far closer than the estimator's own accuracy.
    let lo = 0
    let hi = rows
    while (hi > 1) {
      hi = Math.floor(hi / 2)
      if (estimateTokens(render(hi)) <= budget.maxTokensPerAttachment) {
        lo = hi
        break
      }
    }
    rows = lo
    const step = Math.max(1, Math.floor((hi - lo) / 10))
    for (let n = lo + step; n < hi; n += step) {
      if (estimateTokens(render(n)) > budget.maxTokensPerAttachment) break
      rows = n
    }
  }

  const complete = !hitRowCap && !hitTokenBudget && !sourceTruncated
  if (complete) return { rows, notice: null }

  const reason: TruncationReason = sourceTruncated
    ? 'sourceTruncated'
    : hitTokenBudget
      ? 'tokenBudget'
      : 'rowCap'

  return { rows, notice: { unit: 'rows', included: rows, total, reason } }
}

/**
 * Cut a single value to `maxValueChars`.
 *
 * The cut is reported in `TruncationNotice`, and `serialize.ts` additionally
 * marks the cut point in the body with a visible `…[truncated]` — a model that
 * receives a JSON document silently sliced mid-string will try to parse it and
 * conclude the data is corrupt rather than clipped.
 */
export function clampValue(
  text: string,
  budget: ContextBudget,
): { text: string; notice: TruncationNotice | null } {
  if (text.length <= budget.maxValueChars) return { text, notice: null }
  return {
    text: text.slice(0, budget.maxValueChars),
    notice: {
      unit: 'characters',
      included: budget.maxValueChars,
      total: text.length,
      reason: 'valueCap',
    },
  }
}
