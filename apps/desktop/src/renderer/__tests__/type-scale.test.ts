import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { decomment, scannedSources, stylesheets, tailwindCandidates } from './sourceScan'

/* ==================================================================
 * The type floor, as an executable assertion.
 *
 * peek is a dense tool and that is deliberate, but density with no floor walks
 * downwards on its own: before this test the window had four rungs and the
 * bottom one was **9px**, on a product that ships zh-CN, where 10px PingFang
 * runs its strokes together.
 *
 * The rule this enforces:
 *
 *   Anything that sets type is one of two rungs, and the smaller is 12px.
 *   There is no escape hatch and no way to write a number.
 *
 * ## What changed, and what it cost
 *
 * The five bespoke rungs are gone (§29.10.2). The scale is Tailwind's own, two
 * rungs of it — `text-xs` 12px and `text-sm` 14px — and this file reads their
 * values out of `tailwindcss/theme.css` rather than restating them, so a version
 * bump that moves a rung trips here instead of shipping.
 *
 * It was three for one round. `text-lg` is 18px, and the sites on it were 13px
 * before the migration — a 38% jump that put a Markdown h3 four pixels *above*
 * its h2. Every one of them came down to `text-sm` (§30.4), so the rung has no
 * wearer left and is not in `SCALE`: a scale is what the product uses, and
 * listing a rung nothing wears would license the jump back.
 *
 * Two things this test used to say are gone with them, and both were real:
 *
 *   - **The floor used to be a decision.** 11px was chosen against PingFang and
 *     against macOS's own caption2. 12px is not a decision, it is wherever
 *     Tailwind's ladder happens to stop. It clears the old floor comfortably, so
 *     nothing is *worse* — but if that ladder ever moves down, the reason the
 *     floor exists is here in this comment and nowhere in the value.
 *   - **`--text-mark` is gone, and with it the distinction it named.** It was
 *     10px, below the floor *on purpose*, for things read by shape rather than
 *     read as words: a disclosure caret, a checkbox tick. Being under the floor
 *     was the whole content of the token, and a scale with no rung under 12px
 *     cannot hold that idea. Those glyphs are now 12px like everything else. The
 *     test that policed how often the hatch was used is deleted rather than
 *     weakened — there is no hatch left to police.
 *
 * Inline `fontSize` in a component is checked too, because that is how a rule
 * like this gets routed around without anyone meaning to — the session rail's
 * timestamp was an inline `fontSize: 10` that no stylesheet audit would have
 * caught.
 *
 * ## The three surfaces
 *
 * Type is set three ways now, so it is audited three ways:
 *
 *   1. **the scale itself**, read from Tailwind's `theme.css`, plus an assertion
 *      that `styles.css` has not quietly grown a rung of its own again.
 *   2. **the usage**, read from the size declarations still in the stylesheets
 *      *and* from the `text-*` classes in the source. A size can now be set
 *      without any stylesheet being involved, and a scan that only reads CSS
 *      would go quietly blind as modules migrate.
 *
 * "Size declarations" is two properties, not one, and the second was missing for
 * three rounds: `font` sets a size as part of a shorthand, so a rule can drop
 * below the floor without the string `font-size` occurring anywhere in the file.
 * Planted in the stylesheet at 9px, it was green. See `FONT_SHORTHAND` below for
 * why that shorthand in particular is the worst of the ways round this file.
 *
 * The second half read `className=` attributes at first, and that was a third of
 * the vocabulary short: the same scan run the way Tailwind runs it — every file,
 * raw text, no idea what an attribute is — finds **74** rung sites where the
 * attribute scan found 50. The missing 24 are module-level constants
 * (`const BADGE = '… text-sm'`), template-literal branches, and `ui/spec.ts`,
 * which is not JSX at all. `ui/Menu.tsx` is the clean illustration: three rungs
 * in the file, none of them in an attribute, so the whole popup's type was
 * outside the floor. None of that is exotic; it is just not an attribute, and
 * the floor has to hold wherever a rung can be named. See the header of
 * `__tests__/sourceScan.ts` for why the two scanners exist and which is which.
 *
 * The census guard covers **both surfaces at once** on purpose. The design
 * record (§3.2) proposed counting only `text-*` classes; that number is zero
 * until the first module migrates, so a guard written that way would be red
 * through the whole of phase 0 and phase 1 — which means it would be commented
 * out, which means it would guard nothing at the moment the migration is most
 * capable of losing a rung. The union is non-zero at every step and still shouts
 * the instant the scanner itself stops working, which is the entire job.
 *
 * See design/2026-08-02-ui-legibility-baseline.md §2.1 and
 * docs/design/2026-08-04-tailwind-migration.md §3.2.
 * ================================================================== */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..')

const STYLESHEETS = stylesheets(RENDERER)

/**
 * 文字地板，px。**11 是查过的下限，不是「Tailwind 最小的那个」。**
 *
 * macOS 系统 UI 的最小规格是 11px（caption2），而 peek 发布了 zh-CN ——
 * PingFang SC 在 10px 下笔画会粘连。同一份文档记着它恰好也是 TablePlus
 * 自己的地板。见 design/2026-08-02-ui-legibility-baseline.md §2.1。
 *
 * 它当过一轮 12px：Tailwind 没有 12px 以下的档，于是地板变成了「ladder
 * 碰巧停在哪里」而不是一个决定（§29.10.2）。§32 把决定拿了回来。
 */
const TEXT_MIN = 11

/**
 * 地板之下唯一合法的东西，以及它合法的条件。
 *
 * `--text-mark` 是 10px，**故意**在文字地板之下，因为它承载的不是词：展开
 * 三角 ▸▾、Markdown 的勾 ✔ —— 按形状读，不按字形辨认。条件写在这里而不是
 * 「凡是 10px 都放行」：它必须有一个不由字号决定的外框（caret 列
 * `--spacing-glyph` 14px、勾选框 12×12），且不得承载任何需要辨认的字形。
 *
 * 低于地板必须是**一句写出来的话**，不能是一个偶然的计算结果 —— 这条规矩
 * 是 legibility 基线文档 §2.2.1 立的，本文件只是执行它。
 */
const MARK_RUNG = '--text-mark'

/**
 * 产品的五档，按它们自己的名字。没有第六档。
 *
 * Tailwind 的十三档全部被 `--text-*: initial` 清掉了（§32），所以这五个名字
 * 是窗口里**仅有**的字号词汇 —— 这比上一轮「列出两档、按名字驳回另外十一档」
 * 硬：现在写 `text-lg` 不是被这个测试驳回，是根本编译不出东西来。
 *
 * 名字说的是用途不是大小。`text-xs`/`text-sm` 说的是「小」和「稍小」，
 * 三个月后没人知道该用哪个；`text-micro`（次要文本）和 `text-body`（正文）
 * 说的是这段文字**是什么**。
 */
const SCALE = ['--text-mark', '--text-micro', '--text-body', '--text-title', '--text-hero'] as const

/** The class that names each rung: `--text-xs` is worn as `text-xs`. */
const rungClass = (name: string): string => name.slice(2)

/**
 * `text-` is four namespaces in Tailwind, not the two this file started with.
 *
 * Type (`text-sm`) and colour (`text-fg-dim`) were known. The other two set no
 * type at all and have no value to audit: `text-align`, and the overflow and
 * wrap families. Every phase-2 module hit this at once — a tree row that
 * ellipsises, a settings tab that reads left, a grid cell that clips — which is
 * the signature of a missing case rather than three mistakes.
 *
 * Listed by name, not skipped by shape. "A `text-` class this file does not
 * recognise is allowed" is precisely the fail-open the §3.2 rewrite existed to
 * remove: `text-[13px]` and `text-huge` are unrecognised too, and both have to
 * stay red. A keyword that is genuinely not a size has to be written down here
 * to become legal, which costs one line and keeps the floor closed.
 */
const TEXT_KEYWORDS = new Set([
  // text-align
  'left', 'center', 'right', 'justify', 'start', 'end',
  // text-overflow
  'ellipsis', 'clip',
  // text-wrap
  'wrap', 'nowrap', 'balance', 'pretty',
])

/**
 * The renderer's one stylesheet.
 *
 * It was `theme.css` until the eight sheets were merged back into `styles.css`
 * (migration record §11.1). The `@theme` block is unchanged and so is
 * everything read out of it here; only the path moved. Named as a constant
 * rather than spelled at each of the three call sites, because the next such
 * move should be one edit.
 */
const SHEET = 'styles.css'

/**
 * Tailwind's own theme file, which is now where the scale lives.
 *
 * Read rather than restated. Hardcoding `12 / 14 / 18` here would make this file
 * agree with itself forever and with the shipped CSS only until the next
 * `pnpm up` — and a type ladder that moves under a product is exactly the kind
 * of change that is invisible in a diff and obvious on screen.
 */
/**
 * 一档的 px 值，从**产品自己的** `styles.css` 读，不是从 Tailwind 读。
 *
 * 上一轮读的是 `tailwindcss/theme.css`，理由是「档位是 Tailwind 的，所以
 * 值也应该从那里读，版本升级动了档位就在这里红」。§32 之后档位是产品自己
 * 铸的，Tailwind 的十三档被 `--text-*: initial` 清空了 —— 继续读那个文件
 * 只会读到一堆没人穿的数字。
 *
 * 值直接写 px（不是 rem），所以这里也不再需要 ×16 和「根字号必须是 16px」
 * 那条假设。那条假设本身是对的，但它是**这个文件**的假设而不是产品的属性，
 * 少一条假设就少一处会悄悄失效的地方。
 */
function readVarPx(name: string): number {
  const css = readFileSync(join(RENDERER, SHEET), 'utf8')
  const m = new RegExp(`^\\s*${name}\\s*:\\s*([0-9.]+)px\\s*;`, 'm').exec(css)
  assert.ok(m, `${name} is not declared in ${SHEET} as a px literal`)
  return Number(m[1])
}

/**
 * The colour half of the `text-` prefix, read from `@theme`.
 *
 * `text-fg-faint` and `text-sm` are the same three letters in front of two
 * unrelated namespaces. Telling them apart by reading the theme (rather than by
 * a hardcoded list) means a colour added tomorrow does not read as an illegal
 * type rung the day after.
 */
const VARS_COLOR = new Set(
  [...readFileSync(join(RENDERER, SHEET), 'utf8').matchAll(/^\s*(--color-[a-z0-9-]+)\s*:/gm)].map(
    (m) => m[1],
  ),
)

interface Declaration {
  file: string
  line: number
  /**
   * As written: a `font-size:` value, a rung class name, or — for the shorthand
   * below — the size token lifted out of it, because that is the part this file
   * has an opinion about and the part the `--text-mark` exemption is keyed on.
   */
  raw: string
  px: number
}

/**
 * The `font` shorthand, which states a size without ever writing `font-size`.
 *
 * `font: 9px/1.2 monospace` is one declaration setting six properties, and the
 * sweep below used to read none of them: it looked for a property *named*
 * `font-size`, and this one is named `font`. A rung planted this way sat two
 * pixels under the floor with the whole suite green.
 *
 * It is the worst of the ways round this file, not merely another one, because
 * the same declaration also resets `line-height` — a size the floor can now see
 * and a leading nothing in this repo audits, arriving together, in a value whose
 * grammar puts them next to each other on purpose.
 *
 * Anchored to the start of a line or to a `;`/`{`, which is what tells it apart
 * from the two neighbours it would otherwise swallow: `font-size:` has a `-`
 * where this pattern demands the colon, and `--font-ui:` has two dashes in front
 * of a name this pattern will not start inside.
 */
const FONT_SHORTHAND = /(?:^|[;{])\s*font\s*:\s*([^;}]+)/

/**
 * `font` values that set no size at all, so there is nothing here to audit.
 *
 * `inherit` is the one the renderer writes, twice — on `button` and on the form
 * elements — and it is written precisely *so that* a control inside the 11px
 * status bar stays 11px. See the note above those rules in `styles.css`.
 *
 * The system-font keywords (`caption`, `menu`, `status-bar` …) are deliberately
 * absent: each of them does set a size, one this test cannot read and macOS can
 * change, so they fall through to the assertion below rather than onto this list.
 */
const FONT_NO_SIZE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])

/**
 * The size inside a `font` shorthand value.
 *
 * The grammar is `[style || variant || weight || stretch]? <size>[/<leading>]
 * <family>`, so reading it is "find the length" — and the lengths this repo
 * writes are the same two the longhand accepts, a rung `var()` or a pixel
 * number. Anything else is reported rather than skipped, which is what keeps a
 * value nobody anticipated from reading as a value with no size in it.
 */
const SHORTHAND_SIZE = /(?:^|\s)(var\(--text-[a-z]+\)|[0-9.]+px)(?:\s*\/\s*\S+)?(?=\s|$)/

/**
 * A size set from JavaScript, through a rung.
 *
 * There is a third way to write a `font-size` in this renderer and neither half
 * of `declarations()` could see it: `EditorView.theme({...})` is a plain JS
 * object that style-mod turns into real, unlayered CSS at runtime. It is not a
 * stylesheet, so the CSS reader misses it; it is not a class, so the Tailwind
 * reader misses it. The CodeMirror theme moved out of `styles.css` and into
 * `components/SqlEditor.tsx` carrying its `font-size` with it — the same
 * declaration, one file to the left, and the floor silently stopped applying.
 *
 * Matching only the `var()` form is the point. A rung reference stays tied to
 * the ladder, so it is read here and held to the floor like any other; a bare
 * number is not a rung and is left to the inline-size assertion below to reject.
 * Splitting it this way means neither form escapes: one is audited, the other is
 * banned, and there is no third case that is quietly neither.
 */
const THEME_FONT_SIZE = /\bfontSize\s*:\s*['"`](var\(--text-[a-z]+\))['"`]/

/** Every `.tsx` under `renderer/`. */
function componentFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
    out.push(join(entry.parentPath, entry.name))
  }
  return out.sort()
}

/**
 * Every size set anywhere in the renderer, resolved to pixels.
 *
 * Three parts, because there are three ways to set one. All three resolve
 * through the same three rungs, so a rung that moves moves every call site with
 * it — which is the property that makes this a scale rather than a list of
 * numbers.
 */
function declarations(): Declaration[] {
  const scale = new Map<string, number>()
  for (const name of SCALE) scale.set(name, readVarPx(name))

  /** A written size, resolved through the three rungs. Unreadable is red. */
  const px = (at: string, raw: string): number => {
    const viaVar = /^var\((--text-[a-z]+)\)$/.exec(raw)
    if (viaVar) {
      const rung = scale.get(viaVar[1])
      assert.ok(rung !== undefined, `${at} uses unknown ${viaVar[1]}`)
      return rung
    }
    const bare = /^([0-9.]+)px$/.exec(raw)
    assert.ok(bare, `${at} has a font size this test cannot read: ${raw}`)
    return Number(bare[1])
  }

  const out: Declaration[] = []

  /* ---- the stylesheets ---- */
  for (const sheet of STYLESHEETS) {
    // Comments blanked, line numbers preserved. This scan read raw text until
    // the theme grew a paragraph explaining why Preflight's `h1–h6 { font-size:
    // inherit }` is not wanted — and the paragraph registered as a declaration
    // the test could not parse. Fourth occurrence of the same trap; see the
    // header of __tests__/sourceScan.ts, which was written after the third.
    const lines = decomment(readFileSync(join(RENDERER, sheet), 'utf8')).split('\n')
    lines.forEach((text, i) => {
      const at = `${sheet}:${i + 1}`

      const decl = /font-size:\s*([^;]+);/.exec(text)
      if (decl) {
        const raw = decl[1].trim()
        // `font-size: 0` on .grid-row is a layout trick — it collapses the
        // whitespace text nodes between inline-block cells. It sizes nothing.
        if (raw !== '0') out.push({ file: sheet, line: i + 1, raw, px: px(at, raw) })
      }

      // The same line can legitimately carry both, and a rule that sets one of
      // each is exactly the shape worth reading twice, so this is not an `else`.
      const short = FONT_SHORTHAND.exec(text)
      if (short) {
        const value = short[1].trim()
        if (FONT_NO_SIZE.has(value)) return
        const size = SHORTHAND_SIZE.exec(value)
        assert.ok(
          size,
          `${at} sets type through the \`font\` shorthand, and this test cannot find the size in ` +
            `\`${value}\`.\n` +
            `The shorthand is read here because it reaches a size without the word \`font-size\` ` +
            `appearing anywhere — which is how a 9px rung once shipped past this file. If the ` +
            `value is a system keyword, it takes its size from the OS and this floor cannot hold ` +
            `it: write the longhands instead. Otherwise state the size as a rung \`var()\` or as ` +
            `pixels, the same two forms \`font-size\` is held to, and add the spelling here if it ` +
            `is genuinely a third one.`,
        )
        out.push({ file: sheet, line: i + 1, raw: size[1], px: px(at, size[1]) })
      }
    })
  }

  /* ---- the class strings ---- */
  //
  // Every file Tailwind reads, not every `className=` attribute, and not only
  // `.tsx`. What compiles is decided by Tailwind's scanner; a narrower aperture
  // here is a place where a rung can be broken with the suite green. See the
  // header of __tests__/sourceScan.ts.
  const LEGAL = new Set(SCALE.map(rungClass))
  for (const file of scannedSources(RENDERER)) {
    for (const { line, name: candidate } of tailwindCandidates(
      readFileSync(join(RENDERER, file), 'utf8'),
    )) {
      // `hover:text-fg` and `motion-reduce:text-sm` set the same things under a
      // condition; the condition is not this file's business.
      const name = candidate.slice(candidate.lastIndexOf(':') + 1)
      if (!name.startsWith('text-')) continue
      // `text-fg`, `text-err` … are the colour namespace wearing the same
      // prefix. They are audited by theme-contrast.test.ts, not here.
      if (VARS_COLOR.has(`--color-${name.slice('text-'.length)}`)) continue
      // Alignment, overflow and wrapping share the prefix and size nothing.
      if (TEXT_KEYWORDS.has(name.slice('text-'.length))) continue
      const px = scale.get(`--${name}`)
      assert.ok(
        px !== undefined && LEGAL.has(name),
        `${file}:${String(line)} sets type with \`${name}\`, which is not one of the three rungs ` +
          `(${[...LEGAL].join(', ')}) and is not one of this product's colours either.\n` +
          `Two ways to get here now that Tailwind's defaults are switched back on (§29.10), and ` +
          `they want opposite fixes:\n` +
          `  • a size — \`text-2xl\`, \`text-base\`: ten of Tailwind's thirteen rungs compile and ` +
          `are still not sizes this product has. Use the rung that fits, or add a fourth to SCALE ` +
          `with a reason.\n` +
          `  • a colour — \`text-red-500\`, \`text-zinc-400\`: the default palette compiles too, and ` +
          `it bypasses the semantic tokens entirely. Use \`text-err\`, \`text-fg-dim\` and the rest ` +
          `of the ${String(VARS_COLOR.size)} in ${SHEET}. This branch is the one fence left standing ` +
          `over the \`text-\` half of the palette since the closed set was given up.\n` +
          `An arbitrary value like \`text-[13px]\` is banned outright either way — migration record ` +
          `§3.4.`,
      )
      out.push({ file, line, raw: name, px })
    }
  }

  /* ---- themes injected at runtime ---- */
  //
  // The third surface; see THEME_FONT_SIZE. `EditorView.theme` reaches a real
  // `font-size` without a stylesheet and without a class, which is precisely the
  // shape both readers above are blind to.
  for (const path of componentFiles()) {
    const file = relative(RENDERER, path)
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text, i) => {
        const size = THEME_FONT_SIZE.exec(text)
        if (size) out.push({ file, line: i + 1, raw: size[1], px: px(`${file}:${i + 1}`, size[1]) })
      })
  }

  /*
   * The alarm, not a statistic. Two surfaces are summed because the migration
   * moves weight from one to the other, and a guard on either half alone reads
   * zero for a stretch of the migration and would be deleted for being wrong.
   * If this ever trips, the scanner has stopped finding source — every assertion
   * in this file then passes by having nothing to check.
   */
  assert.ok(
    out.length > 40,
    `the scan found only ${String(out.length)} places where type is sized, across the renderer's ` +
      `${String(STYLESHEETS.length)} stylesheet(s) and every .tsx in it. That is not a small ` +
      `codebase, it is a broken scanner — and a broken scanner here is a green build with no floor.`,
  )
  return out
}

/**
 * A `--leading-*` token's px value, following at most one `var()` hop.
 *
 * Returns null for a ratio, a `calc()`, or an indirection deeper than one hop —
 * all three are things this file's line-box rule is meant to reject.
 */
function resolvePx(css: string, name: string): number | null {
  const decl = new RegExp(`^\\s*${name}\\s*:\\s*([^;]+);`, 'm').exec(css)
  if (decl === null) return null
  const raw = decl[1].trim()
  const literal = /^([0-9.]+)px$/.exec(raw)
  if (literal !== null) return Number(literal[1])
  const hop = /^var\(\s*(--[a-z-]+)\s*\)$/.exec(raw)
  if (hop === null) return null
  const inner = new RegExp(`^\\s*${hop[1]}\\s*:\\s*([0-9.]+)px\\s*;`, 'm').exec(css)
  return inner === null ? null : Number(inner[1])
}

/* ------------------------------------------------------------------ */

describe('the type scale', () => {
  test('the scale is five rungs, ordered, with the floor as the second', () => {
    const px = SCALE.map(readVarPx)

    // 具名，所以失败时说的是「哪一档动了」而不只是「有一档动了」。
    assert.deepEqual(px, [10, 11, 12, 14, 16], 'the rungs are 10 / 11 / 12 / 14 / 16px')
    assert.deepEqual(
      px,
      [...px].sort((a, b) => a - b),
      `SCALE must be written in ascending order — the floor test reads position, not value`,
    )
    assert.equal(
      px[1],
      TEXT_MIN,
      `the second rung is the text floor. The first is under it on purpose (${MARK_RUNG}); ` +
        `every other rung is above it.`,
    )
  })

  test('every rung carries a line box, and every line box is an even whole number', () => {
    /*
     * 这是本轮的核心不变式，写成断言。
     *
     * 比值行高乘字号必然产生小数：12 × 1.45 = 17.390625（Chromium 按 1/64px
     * 量化）。87 个实测面里 37 个的小数几何全部追到那一行（§31.2）。所以
     * 这里同时要两件事：每一档都配了行盒（不许有档位落回继承），且每个行盒
     * 都是偶数整数 px（奇数行盒在偶数容器里居中又会掉回半像素）。
     */
    const css = readFileSync(join(RENDERER, SHEET), 'utf8')
    const bad: string[] = []
    for (const rung of SCALE) {
      const pair = new RegExp(`^\\s*${rung}--line-height\\s*:\\s*([^;]+);`, 'm').exec(css)
      if (pair === null) {
        bad.push(`${rung} has no paired line height`)
        continue
      }
      const named = /var\(\s*(--leading-[a-z-]+)\s*\)/.exec(pair[1])
      if (named === null) {
        bad.push(`${rung}--line-height is \`${pair[1].trim()}\`, not a --leading-* token`)
        continue
      }
      /*
       * 跟一跳 `var()`。
       *
       * 规则是「解析成偶数整数 px」，不是「写成 px 字面量」——`--leading-row`
       * 故意写成 `var(--spacing-row)`，因为 `vscroll.ts` 用行高算产品里每一个
       * 滚动偏移，行盒必须**跟着**那个令牌走而不是复制它的当前值。第一版这个
       * 检查只认字面量，于是把这处正确的间接引用报成了违规。
       *
       * 只跟一跳：两跳以上就不是「派生」而是绕路了，那种应该红。
       */
      const px = resolvePx(css, named[1])
      if (px === null) {
        bad.push(`${named[1]} does not resolve to a px value in one hop — a ratio is what this rule bans`)
        continue
      }
      if (!Number.isInteger(px) || px % 2 !== 0) bad.push(`${named[1]} is ${String(px)}px, not an even whole number`)
    }
    assert.deepEqual(
      bad,
      [],
      `每一档必须配一个具名的 --leading-* 令牌，且它必须是偶数整数 px。\n` +
        `比值（1.45、1.625…）乘字号会产生小数，小数是这个窗口分数几何的唯一来源；\n` +
        `奇数行盒在偶数容器里居中会掉回半像素。见 §31.2 与 §32：\n${bad.join('\n')}`,
    )
  })

  test('the root font size is 16px, which is what makes rem→px above true', () => {
    // readVarPx multiplies by 16. Nothing here sets a root size today, so 1rem
    // is the browser default — but "nobody has written it yet" is a fact about
    // the file, not a guarantee, and every number in this test rides on it.
    const css = decomment(readFileSync(join(RENDERER, SHEET), 'utf8'))
    const root = /(?:^|[;{}\s])html\b[^{}]*\{[^{}]*?\bfont-size\s*:/.exec(css)
    assert.equal(
      root,
      null,
      `${SHEET} now sets a font-size on \`html\`. Tailwind's rungs are in rem, so that ` +
        `re-scales the entire type ladder — including the ${String(TEXT_MIN)}px floor, which ` +
        `is only ${String(TEXT_MIN)}px while 1rem is 16px. Convert readVarPx to read the new ` +
        `root, or state why the floor survives it.`,
    )
  })

  test('styles.css declares no type rung of its own', () => {
    // The inverse of the assertion this replaced. That one required
    // `--text-*: initial` to be present, so that only the five bespoke rungs
    // existed; that reset is deliberately gone (§29.10). What matters now is the
    // other direction — a bespoke rung reintroduced into @theme would shadow one
    // of Tailwind's, silently, under a name this file already believes it knows.
    const own = [
      ...decomment(readFileSync(join(RENDERER, SHEET), 'utf8')).matchAll(
        /^\s*(--text-[a-z0-9-]+)\s*:/gm,
      ),
    ].map((m) => m[1])
    assert.deepEqual(
      own.filter((n) => !n.endsWith('--line-height')),
      SCALE.map((n) => n),
      `${SHEET} must declare exactly the scale in SCALE and nothing else. Tailwind's ladder is ` +
        `cleared with \`--text-*: initial\`, so this file is the only source of type in the ` +
        `window — a rung here that SCALE has not heard of is a sixth size nobody decided on, and ` +
        `a rung in SCALE that is missing here compiles to nothing at all.`,
    )
  })

  test('nothing is set below the text floor, and the one exemption is named', () => {
    const markPx = readVarPx(MARK_RUNG)
    const offenders = declarations()
      .filter((d) => d.px < TEXT_MIN && !d.raw.includes(rungClass(MARK_RUNG)))
      .map((d) => `${d.file}:${d.line} → ${d.raw} (${d.px}px)`)
    assert.deepEqual(
      offenders,
      [],
      `text below ${String(TEXT_MIN)}px must grow. The one thing allowed under the floor is ` +
        `\`${rungClass(MARK_RUNG)}\` (${String(markPx)}px), and it is allowed because it does not carry words — ` +
        `a caret or a tick is read by shape. Wearing it on anything a reader has to *read* is the ` +
        `abuse this exemption invites, and no test can catch that; wearing a bare size under the ` +
        `floor is what this catches:\n${offenders.join('\n')}`,
    )
  })

  test('the mark rung is under the floor on purpose, not by accident', () => {
    // If somebody ever raises `--text-mark` to the floor, the exemption above
    // silently stops meaning anything and this test says so rather than passing.
    assert.ok(
      readVarPx(MARK_RUNG) < TEXT_MIN,
      `${MARK_RUNG} is ${String(readVarPx(MARK_RUNG))}px, at or above the ${String(TEXT_MIN)}px floor. It exists to be ` +
        `below it; if it no longer is, delete it and the exemption with it.`,
    )
  })
})

describe('no inline font sizes in components', () => {
  test('every font-size lives in a stylesheet, a class, or a rung reference', () => {
    const offenders: string[] = []
    for (const path of componentFiles()) {
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((text, i) => {
        if (!/\bfontSize\b/.test(text)) return
        // A rung reference is not a bypass — it is the ladder, written from
        // JavaScript because the surface it styles has no other hook.
        // `declarations()` picks these up and the floor holds them, so passing
        // here is a handoff rather than an exemption.
        if (THEME_FONT_SIZE.test(text)) return
        offenders.push(`${relative(RENDERER, path)}:${i + 1}`)
      })
    }
    assert.deepEqual(
      offenders,
      [],
      `inline fontSize bypasses the type scale; give it a class, or — if the element is built by a ` +
        `library and has no class to give — set it through a rung: \`fontSize: 'var(--text-sm)'\`, ` +
        `which stays tied to the ladder and is audited with the rest of it:\n${offenders.join('\n')}`,
    )
  })
})
