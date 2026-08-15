/**
 * Pulling every colour the shipped stylesheet can produce out of its own text.
 *
 * This is the allow-set the painted-colour sweep is held to, and it is derived
 * rather than curated on purpose: a hand-written palette list in the probe would
 * be a second source of truth about what ships, and the whole point of this
 * fence is that it reads what the browser did, not what somebody wrote down.
 *
 * The scanner is deliberate about two things:
 *
 *  - **balanced parentheses.** `color-mix(in srgb, var(--a) 25%, transparent)`
 *    nests, and a regex ending in `\)` either stops in the middle of it or eats
 *    the next colour in a `box-shadow` list. Either way the value fails to parse
 *    later and drops silently out of the allow-set — which shows up as a false
 *    violation somewhere else entirely.
 *  - **it may over-collect, never under-collect.** A token that is not a colour
 *    fails to parse in the browser and is dropped there. A colour that is missed
 *    here becomes a violation with no defect behind it. So when in doubt the
 *    scanner takes the token.
 */

/** The CSS named colours, plus the two keywords that behave like them. */
const NAMED = new Set(
  (
    'transparent currentcolor aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral ' +
    'cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen ' +
    'darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon ' +
    'darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink ' +
    'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ' +
    'ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
)

const FUNCS = [
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
]

const IDENT = /[a-zA-Z-]/

/** Every colour-shaped token in a stylesheet's text, deduplicated, in order. */
export function extractColours(css) {
  const found = new Set()
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '#') {
      let j = i + 1
      while (j < css.length && /[0-9a-fA-F]/.test(css[j])) j += 1
      const len = j - i - 1
      if (len === 3 || len === 4 || len === 6 || len === 8) found.add(css.slice(i, j))
      i = j - 1
      continue
    }
    if (!IDENT.test(ch)) continue
    if (i > 0 && (IDENT.test(css[i - 1]) || css[i - 1] === '-' || /[0-9]/.test(css[i - 1]))) continue
    let j = i
    while (j < css.length && (IDENT.test(css[j]) || /[0-9]/.test(css[j]))) j += 1
    const word = css.slice(i, j)
    if (css[j] === '(' && FUNCS.includes(word.toLowerCase())) {
      let depth = 0
      let k = j
      for (; k < css.length; k += 1) {
        if (css[k] === '(') depth += 1
        else if (css[k] === ')') {
          depth -= 1
          if (depth === 0) {
            k += 1
            break
          }
        }
      }
      found.add(css.slice(i, k))
      i = k - 1
      continue
    }
    if (NAMED.has(word.toLowerCase())) found.add(word)
    i = j - 1
  }
  return [...found]
}

/* ---------------------------------------------------------------- */
/* Contrast                                                          */
/* ---------------------------------------------------------------- */

function channel(v) {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of an opaque 8-bit colour. */
export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1–21. */
export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
