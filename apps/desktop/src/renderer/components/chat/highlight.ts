/* ==================================================================
 * Code-block colouring, hand-rolled.
 *
 * The alternatives were Shiki (a full TextMate engine plus a WASM oniguruma
 * build, megabytes) and highlight.js (~50 languages nobody here writes). peek's
 * chat panel needs to colour four things — SQL, JSON, JS/TS and shell — because
 * those are what an agent talking to a database viewer actually emits, and a
 * single-pass tokenizer per language is a few hundred lines.
 *
 * This is a *tokenizer*, not a parser: it never validates and never fails. Code
 * arrives mid-stream with an unterminated string on the last line, and the only
 * acceptable behaviour is to colour what is there and move on.
 * ================================================================== */

export type TokenKind = 'plain' | 'keyword' | 'type' | 'string' | 'number' | 'comment' | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

/** Languages with a real tokenizer; everything else renders uncoloured. */
export type HighlightLang = 'sql' | 'json' | 'js' | 'shell' | 'plain'

const LANG_ALIASES: Readonly<Record<string, HighlightLang>> = {
  sql: 'sql',
  postgres: 'sql',
  postgresql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  js: 'js',
  jsx: 'js',
  javascript: 'js',
  ts: 'js',
  tsx: 'js',
  typescript: 'js',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
}

export function normalizeLang(raw: string): HighlightLang {
  return LANG_ALIASES[raw.trim().toLowerCase()] ?? 'plain'
}

const SQL_KEYWORDS = new Set(
  (
    'select from where group by order having limit offset insert into values update set delete '
    + 'create alter drop table view index schema database materialized join inner left right full outer '
    + 'cross on using union all distinct as and or not null is in like ilike between exists case when '
    + 'then else end asc desc with recursive returning conflict do nothing primary key foreign references '
    + 'constraint unique check default cascade begin commit rollback explain analyze vacuum grant revoke '
    + 'window partition over rows range preceding following unbounded current row lateral fetch next only'
  ).split(' '),
)

const SQL_TYPES = new Set(
  (
    'int integer bigint smallint serial bigserial numeric decimal real double precision float text varchar '
    + 'char boolean bool date time timestamp timestamptz interval json jsonb uuid bytea array vector'
  ).split(' '),
)

const JS_KEYWORDS = new Set(
  (
    'const let var function return if else for while do break continue switch case default new delete '
    + 'typeof instanceof in of this class extends super import export from as async await yield try catch '
    + 'finally throw void null undefined true false interface type enum implements readonly public private '
    + 'protected static satisfies keyof infer declare namespace abstract'
  ).split(' '),
)

const SHELL_KEYWORDS = new Set(
  'if then else elif fi for while do done case esac function return export local set unset source cd echo'.split(' '),
)

const IDENT_START = /[A-Za-z_$]/
const IDENT_PART = /[A-Za-z0-9_$]/
const DIGIT = /[0-9]/
const PUNCT = /[{}()[\];,.:+\-*/%<>=!&|^~?@#]/

/** Tokenize `src`. Adjacent tokens of the same kind are merged by the caller's renderer. */
export function highlight(src: string, lang: HighlightLang): Token[] {
  switch (lang) {
    case 'sql':
      return tokenizeSql(src)
    case 'json':
      return tokenizeJson(src)
    case 'js':
      return tokenizeCLike(src, JS_KEYWORDS, new Set<string>(), true)
    case 'shell':
      return tokenizeShell(src)
    case 'plain':
      return src === '' ? [] : [{ kind: 'plain', text: src }]
  }
}

function pushTok(out: Token[], kind: TokenKind, text: string): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

/** Consume a quoted run. Returns the index after the closing quote, or `src.length`
 *  when the string is still being streamed — never -1, never a throw. */
function readString(src: string, at: number, quote: string, escapes: boolean): number {
  let i = at + 1
  while (i < src.length) {
    const ch = src[i]
    if (escapes && ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) {
      // SQL doubles the quote to escape it: 'it''s'.
      if (!escapes && src[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return src.length
}

function readNumber(src: string, at: number): number {
  let i = at
  while (i < src.length && (DIGIT.test(src[i] ?? '') || src[i] === '.' || src[i] === '_')) i += 1
  if (src[i] === 'e' || src[i] === 'E') {
    i += 1
    if (src[i] === '+' || src[i] === '-') i += 1
    while (i < src.length && DIGIT.test(src[i] ?? '')) i += 1
  }
  return i
}

function tokenizeSql(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''

    if (ch === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      pushTok(out, 'comment', src.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      pushTok(out, 'comment', src.slice(i, end))
      i = end
      continue
    }
    if (ch === "'") {
      const end = readString(src, i, "'", false)
      pushTok(out, 'string', src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"' || ch === '`') {
      // A quoted identifier, not a string literal — colour it as a type-ish name.
      const end = readString(src, i, ch, false)
      pushTok(out, 'type', src.slice(i, end))
      i = end
      continue
    }
    if (DIGIT.test(ch)) {
      const end = readNumber(src, i)
      pushTok(out, 'number', src.slice(i, end))
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < src.length && IDENT_PART.test(src[j] ?? '')) j += 1
      const word = src.slice(i, j)
      const lower = word.toLowerCase()
      pushTok(out, SQL_KEYWORDS.has(lower) ? 'keyword' : SQL_TYPES.has(lower) ? 'type' : 'plain', word)
      i = j
      continue
    }
    if (PUNCT.test(ch)) {
      pushTok(out, 'punct', ch)
      i += 1
      continue
    }
    pushTok(out, 'plain', ch)
    i += 1
  }
  return out
}

function tokenizeJson(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''
    if (ch === '"') {
      const end = readString(src, i, '"', true)
      // A string immediately followed by `:` is a key; colour it apart from values.
      let k = end
      while (k < src.length && /\s/.test(src[k] ?? '')) k += 1
      pushTok(out, src[k] === ':' ? 'type' : 'string', src.slice(i, end))
      i = end
      continue
    }
    if (DIGIT.test(ch) || (ch === '-' && DIGIT.test(src[i + 1] ?? ''))) {
      const end = readNumber(src, ch === '-' ? i + 1 : i)
      pushTok(out, 'number', src.slice(i, end))
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < src.length && IDENT_PART.test(src[j] ?? '')) j += 1
      const word = src.slice(i, j)
      pushTok(out, word === 'true' || word === 'false' || word === 'null' ? 'keyword' : 'plain', word)
      i = j
      continue
    }
    if (PUNCT.test(ch)) {
      pushTok(out, 'punct', ch)
      i += 1
      continue
    }
    pushTok(out, 'plain', ch)
    i += 1
  }
  return out
}

function tokenizeCLike(
  src: string,
  keywords: ReadonlySet<string>,
  types: ReadonlySet<string>,
  templates: boolean,
): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i] ?? ''

    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      pushTok(out, 'comment', src.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? src.length : close + 2
      pushTok(out, 'comment', src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"' || ch === "'" || (templates && ch === '`')) {
      const end = readString(src, i, ch, true)
      pushTok(out, 'string', src.slice(i, end))
      i = end
      continue
    }
    if (DIGIT.test(ch)) {
      const end = readNumber(src, i)
      pushTok(out, 'number', src.slice(i, end))
      i = end
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < src.length && IDENT_PART.test(src[j] ?? '')) j += 1
      const word = src.slice(i, j)
      pushTok(out, keywords.has(word) ? 'keyword' : types.has(word) ? 'type' : 'plain', word)
      i = j
      continue
    }
    if (PUNCT.test(ch)) {
      pushTok(out, 'punct', ch)
      i += 1
      continue
    }
    pushTok(out, 'plain', ch)
    i += 1
  }
  return out
}

function tokenizeShell(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let atCommandStart = true
  while (i < src.length) {
    const ch = src[i] ?? ''

    if (ch === '#' && (i === 0 || /\s/.test(src[i - 1] ?? ' '))) {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      pushTok(out, 'comment', src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      const end = readString(src, i, ch, ch === '"')
      pushTok(out, 'string', src.slice(i, end))
      i = end
      atCommandStart = false
      continue
    }
    if (ch === '$') {
      let j = i + 1
      while (j < src.length && IDENT_PART.test(src[j] ?? '')) j += 1
      pushTok(out, 'type', src.slice(i, j))
      i = j
      continue
    }
    if (IDENT_START.test(ch)) {
      let j = i
      while (j < src.length && (IDENT_PART.test(src[j] ?? '') || src[j] === '-')) j += 1
      const word = src.slice(i, j)
      pushTok(out, SHELL_KEYWORDS.has(word) || atCommandStart ? 'keyword' : 'plain', word)
      i = j
      atCommandStart = false
      continue
    }
    if (ch === '\n' || ch === '|' || ch === ';' || ch === '&') atCommandStart = true
    if (PUNCT.test(ch)) {
      pushTok(out, 'punct', ch)
      i += 1
      continue
    }
    pushTok(out, 'plain', ch)
    i += 1
  }
  return out
}
