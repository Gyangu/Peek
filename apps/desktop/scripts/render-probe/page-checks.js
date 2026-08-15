/*
 * Page-side half of the render probe. Injected as text and evaluated in the
 * probe page; it *measures* and never asserts. Every judgement is made in
 * `probe-main.mjs`, so a failure message is written once, in Node, where it can
 * name a file and a number.
 *
 * Not a module and not built: it is read off disk and handed to
 * `executeJavaScript`, so it must be plain script text with no imports. Keep it
 * that way — a `import`/`export` here fails at evaluation with a syntax error
 * that says nothing about why.
 *
 * The one invariant worth stating up front: **this file reads the browser, not
 * the source.** `getComputedStyle` is downstream of the class string, the
 * stylesheet, the artifact, an inline `style` attribute, an `!important`, and
 * the user-agent's own defaults — all six converge here. Anything measured by
 * reading text belongs in a test under `src/renderer/__tests__/`, not here.
 */

;(() => {
  /* ---------------------------------------------------------------- */
  /* Canonicalising a colour                                           */
  /* ---------------------------------------------------------------- */

  /*
   * Two colours are the same colour when they paint the same pixel.
   *
   * String comparison cannot say that: the artifact writes `#4d9cff`, the
   * computed style says `rgb(77, 156, 255)`, and a `color-mix()` serialises as
   * `oklab(...)` or `color(srgb ...)` depending on the interpolation space. So
   * every value — from the stylesheet, from a computed style, from anywhere —
   * goes through one canvas and comes back as four integers.
   *
   * The canvas is also the parser: a value it cannot parse leaves `fillStyle`
   * at the sentinel, and that is reported rather than silently treated as
   * black.
   */
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  /** Resolves `var()` / `currentColor` / `color-mix()` in the root's context. */
  const resolver = document.createElement('span')
  resolver.setAttribute('data-probe-resolver', '')
  resolver.style.display = 'none'

  const SENTINEL = '#010203'
  const canonCache = new Map()

  function canon(value) {
    if (typeof value !== 'string' || value.trim() === '') return null
    const cached = canonCache.get(value)
    if (cached !== undefined) return cached
    let resolved = value
    // `var()` and `color-mix()` only resolve against a real element in the tree.
    if (value.includes('var(') || value.includes('color-mix(') || value === 'currentColor') {
      resolver.style.color = ''
      resolver.style.color = value
      resolved = getComputedStyle(resolver).color
    }
    ctx.fillStyle = SENTINEL
    ctx.fillStyle = resolved
    if (ctx.fillStyle === SENTINEL && resolved.replace(/\s/g, '').toLowerCase() !== SENTINEL) {
      canonCache.set(value, null)
      return null
    }
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    const out = [d[0], d[1], d[2], d[3]]
    canonCache.set(value, out)
    return out
  }

  const key = (c) => (c === null ? null : c.join(','))

  /* ---------------------------------------------------------------- */
  /* Naming an element in a failure message                            */
  /* ---------------------------------------------------------------- */

  function describe(el) {
    if (el === document.documentElement) return ':root'
    if (el === document.body) return 'body'
    const bits = [el.tagName.toLowerCase()]
    if (el.id !== '') bits.push('#' + el.id)
    const cls = typeof el.className === 'string' ? el.className.trim() : ''
    if (cls !== '') bits.push('.' + cls.split(/\s+/).slice(0, 4).join('.'))
    for (const attr of ['data-probe-variant', 'data-probe-dot', 'type', 'role']) {
      const v = el.getAttribute(attr)
      if (v !== null && v !== '') bits.push(`[${attr}=${v}]`)
    }
    const parent = el.parentElement
    const prefix = parent === null || parent === document.body ? '' : describe(parent) + ' > '
    return prefix + bits.join('')
  }

  const all = () => Array.from(document.querySelectorAll('body *'))

  /**
   * A stable identity for one element, minted on first sight.
   *
   * `describe()` is for humans and is deliberately not unique — thirty buttons
   * in a gallery describe identically, and a caller that keyed a map on the
   * description would collapse them into one and then report a sweep of six
   * where twenty-five were tagged. That mistake was made once, by the state
   * sweep, and it cost three quarters of that pane's coverage. So anything that
   * has to say *the same element again later* uses this.
   */
  let uidCounter = 0
  const uidOf = (el) => {
    let v = el.getAttribute('data-probe-uid')
    if (v === null) {
      uidCounter += 1
      v = String(uidCounter)
      el.setAttribute('data-probe-uid', v)
    }
    return v
  }

  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }

  /* ---------------------------------------------------------------- */
  /* 1. Fail-closed: is this a styled page at all?                     */
  /* ---------------------------------------------------------------- */

  /*
   * The reason this exists, in one sentence: a probe earlier in this very
   * session produced a full set of plausible numbers off a page whose
   * stylesheet had not loaded, and its author caught it by accident.
   *
   * So three independent answers, and the caller requires all three:
   *
   *  - the sheet is there and its rules can be counted (only possible because
   *    the page inlines it — a `file://` `<link>` is cross-origin and `cssRules`
   *    throws);
   *  - the theme reached the root, so `var()` has something to resolve;
   *  - and a **functional** one: a real control out of the product measures like
   *    a control. An unstyled `<button>` has no radius and is nowhere near
   *    24px tall. This is the check the earlier probe did not have.
   */
  /** Style rules at every depth, descending through `@layer` / `@media` / `@supports`. */
  function countStyleRules(rules) {
    let n = 0
    for (const rule of rules) {
      if (rule.selectorText !== undefined) n += 1
      if (rule.cssRules !== undefined && rule.cssRules !== null) n += countStyleRules(rule.cssRules)
    }
    return n
  }

  function sanity() {
    const sheets = Array.from(document.styleSheets)
    let ruleCount = null
    let styleRuleCount = null
    let ruleError = null
    try {
      ruleCount = sheets.length === 0 ? 0 : sheets[0].cssRules.length
      // Counted *recursively*, because the top-level count is not a measure of
      // this artifact: Tailwind emits nearly everything inside `@layer` blocks,
      // so a 39 kB sheet with five hundred style rules reports 129 rules at the
      // top level. A floor set against the flat number would be a floor set
      // against the wrong quantity — and one that moves whenever the layer
      // structure does.
      styleRuleCount = sheets.length === 0 ? 0 : countStyleRules(sheets[0].cssRules)
    } catch (err) {
      ruleError = String(err && err.message ? err.message : err)
    }
    const root = getComputedStyle(document.documentElement)
    const buttons = Array.from(document.querySelectorAll('button'))
    const shaped = buttons
      .map((b) => {
        const cs = getComputedStyle(b)
        return {
          where: describe(b),
          borderRadius: cs.borderRadius,
          minHeight: cs.minHeight,
          height: b.getBoundingClientRect().height,
          fontSize: cs.fontSize,
          background: cs.backgroundColor,
        }
      })
      .filter((b) => b.borderRadius !== '0px' && b.height >= 18)
    return {
      sheetCount: sheets.length,
      ruleCount,
      styleRuleCount,
      ruleError,
      colorScheme: root.colorScheme,
      themeVars: {
        bg: root.getPropertyValue('--color-bg').trim(),
        fg: root.getPropertyValue('--color-fg').trim(),
        accent: root.getPropertyValue('--color-accent').trim(),
      },
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      elementCount: all().length,
      buttonCount: buttons.length,
      shapedButtonCount: shaped.length,
      firstButton: buttons.length === 0 ? null : (shaped[0] ?? null),
    }
  }

  /* ---------------------------------------------------------------- */
  /* 2. Every colour the browser painted                               */
  /* ---------------------------------------------------------------- */

  /*
   * The rule: **every colour on screen must be one the shipped stylesheet can
   * produce.**
   *
   * The allow-set is built in Node out of the artifact's own text and passed in
   * here, so it is not a hand-maintained list that can drift from what ships. A
   * colour arriving by any other channel — an inline `style`, a `setProperty`
   * from an effect, a value handed in by a driver — is not in that set, which is
   * exactly the class of defect no source-reading fence can see.
   *
   * Properties are skipped when the thing they colour is not painted (a border
   * with `style: none`, a fully transparent background): the value is still
   * computed, and holding an invisible colour to the palette would be a
   * false positive with no user behind it.
   */
  function colours(allowed) {
    const allow = new Set(allowed.map((v) => key(canon(v))).filter((k) => k !== null))
    const unresolvable = allowed.filter((v) => canon(v) === null)
    const SIDES = ['Top', 'Right', 'Bottom', 'Left']
    const violations = []
    let checked = 0
    for (const el of all()) {
      if (el.hasAttribute('data-probe-resolver')) continue
      const cs = getComputedStyle(el)
      const pairs = []
      pairs.push(['color', cs.color])
      if (canon(cs.backgroundColor)?.[3] !== 0) pairs.push(['background-color', cs.backgroundColor])
      for (const side of SIDES) {
        const style = cs['border' + side + 'Style']
        const width = Number.parseFloat(cs['border' + side + 'Width'])
        if (style !== 'none' && style !== 'hidden' && width > 0) {
          pairs.push(['border-' + side.toLowerCase() + '-color', cs['border' + side + 'Color']])
        }
      }
      if (cs.outlineStyle !== 'none' && Number.parseFloat(cs.outlineWidth) > 0) {
        pairs.push(['outline-color', cs.outlineColor])
      }
      if (cs.textDecorationLine !== 'none') {
        pairs.push(['text-decoration-color', cs.textDecorationColor])
      }
      if (el instanceof SVGElement) {
        if (cs.fill !== 'none') pairs.push(['fill', cs.fill])
        if (cs.stroke !== 'none') pairs.push(['stroke', cs.stroke])
      }
      for (const [prop, value] of pairs) {
        const k = key(canon(value))
        checked += 1
        if (k === null || allow.has(k)) continue
        violations.push({ where: describe(el), prop, value, rgba: k })
      }
    }
    return { checked, allowSize: allow.size, unresolvable, violations }
  }

  /* ---------------------------------------------------------------- */
  /* 3. Text, and the surface it is actually read against              */
  /* ---------------------------------------------------------------- */

  /*
   * The sweep above asks whether a colour is one the artifact can produce. That
   * is a **membership** question, and membership cannot answer the only question
   * a reader has: *can I read this?* Both halves of
   *
   *     button { color: X !important; background-color: X !important }
   *
   * are colours the artifact produces, so every button in the window can go to a
   * solid invisible block with the membership sweep reporting a clean page.
   *
   * So this function hands back, for every element that paints text, the ink and
   * the **whole stack of paint underneath it**, down to the first fully opaque
   * layer. It composites nothing and judges nothing: `probe-main.mjs` does both,
   * with the one copy of the WCAG maths this repository owns.
   *
   * Three things make the backdrop the hard half, and each of them is a way a
   * naive version passes while blind:
   *
   *  - a translucent or absent background is not a background. The layer the
   *    text is read against is whatever survives compositing up the ancestor
   *    chain, and this app has translucent surfaces on purpose;
   *  - `opacity` fades an element **and its whole subtree**, so it moves the ink
   *    and the surface underneath it by different amounts. It is collected per
   *    node and multiplied down;
   *  - a background *image* — a gradient, a picture — has no single colour. This
   *    reports that it hit one and stops, rather than inventing a number. What to
   *    do about it is a judgement, so it is made in Node.
   *
   * `--color-*` reach elements through `var()` and `color-mix()`. Nothing here
   * resolves those, and nothing needs to: `getComputedStyle` hands back a
   * resolved colour. That is checked rather than assumed — the values that come
   * out of here are canonicalised through the same canvas as everything else,
   * and a value that failed to resolve would not parse and is reported as such.
   */

  /** The text of an element's own child text nodes — not its descendants'. */
  function ownText(el) {
    let s = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) s += node.nodeValue
    }
    return s.replace(/\s+/g, ' ').trim()
  }

  const opacityOf = (el) => {
    const v = Number.parseFloat(getComputedStyle(el).opacity)
    return Number.isFinite(v) ? v : 1
  }

  /** The product of every `opacity` from `el` to the root — what the group is faded by. */
  function cumulativeOpacity(el) {
    let o = 1
    let node = el
    while (node !== null) {
      o *= opacityOf(node)
      node = node.parentElement
    }
    return o
  }

  /**
   * The paint under one element, innermost first, stopping at the first layer
   * that is fully opaque and unfaded.
   *
   * Returns `resolved: false` with a reason instead of guessing whenever the
   * stack cannot be reduced to a colour: a background image anywhere in it, a
   * background that will not parse, or a chain that reaches the root without
   * anything opaque in it. Each of those is a real thing that can happen and
   * none of them has a right answer here, so none of them is answered here.
   */
  function backdropStack(el) {
    const layers = []
    let node = el
    while (node !== null) {
      const cs = getComputedStyle(node)
      if (cs.backgroundImage !== 'none') {
        return {
          resolved: false,
          why: 'background-image',
          where: describe(node),
          detail: cs.backgroundImage.slice(0, 120),
          layers,
        }
      }
      const c = canon(cs.backgroundColor)
      if (c === null) {
        return {
          resolved: false,
          why: 'unparseable background',
          where: describe(node),
          detail: cs.backgroundColor,
          layers,
        }
      }
      if (c[3] !== 0) {
        const o = cumulativeOpacity(node)
        layers.push({ where: describe(node), rgba: c, opacity: o })
        if (c[3] === 255 && o === 1) return { resolved: true, layers }
      }
      node = node.parentElement
    }
    return { resolved: false, why: 'nothing opaque behind it', where: ':root', detail: '', layers }
  }

  /**
   * Every place one element paints characters.
   *
   * Three kinds, because text arrives three ways and only the first is a text
   * node: an element's own words, the **value** inside a form control (which is
   * painted by the control, not by a child), and its **placeholder** (whose ink
   * is a pseudo-element's, so no walk over elements can see it).
   */
  function inkSites(el) {
    const cs = getComputedStyle(el)
    const sites = []
    const words = ownText(el)
    if (words !== '') sites.push({ kind: 'text', sample: words.slice(0, 40), ink: cs.color })
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (typeof el.value === 'string' && el.value.trim() !== '') {
        sites.push({ kind: 'value', sample: el.value.slice(0, 40), ink: cs.color })
      }
      const ph = el.getAttribute('placeholder')
      if (ph !== null && ph.trim() !== '' && (el.value ?? '') === '') {
        sites.push({
          kind: 'placeholder',
          sample: ph.slice(0, 40),
          ink: getComputedStyle(el, '::placeholder').color,
        })
      }
    }
    return sites
  }

  /**
   * What kind of thing is painting this text.
   *
   * Coarse on purpose. The Node side uses it to ask *did this class of element
   * stop contributing*, and a taxonomy with a bucket per component would answer
   * that question about buckets of one. Four buckets, and every element lands in
   * exactly one of them.
   */
  function subjectOf(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button'
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'field'
    if (tag === 'a') return 'link'
    return 'prose'
  }

  /*
   * Whether the thing painting this text is switched off.
   *
   * Reported, never judged: WCAG's carve-out for an inactive component is a
   * decision, and decisions are made in Node. `disabled` is read off the element
   * *and* looked for on an ancestor, because a control's label is a child of the
   * control and a fieldset disables everything inside it.
   */
  function isInactive(el) {
    if ('disabled' in el && el.disabled === true) return true
    return el.closest('[disabled], [aria-disabled="true"], fieldset:disabled') !== null
  }

  /**
   * The walk, over whatever set of elements it is handed.
   *
   * Split out from `textPairs` for the interaction-state sweep, which walks the
   * subtree of one element at a time while that element is hovered, pressed or
   * focused. Same filters, same canonicalisation, same shape of result: the
   * state sweep must not be a second, subtly different reader, because two
   * readers that disagree about what counts as a pair would make "the hovered
   * page grades the same sites as the resting one" unfalsifiable.
   */
  function pairsOver(elements) {
    const pairs = []
    const skipped = []
    let sites = 0
    for (const el of elements) {
      if (el.hasAttribute('data-probe-resolver')) continue
      const found = inkSites(el)
      if (found.length === 0) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const where = describe(el)
      const fade = cumulativeOpacity(el)
      // Each of these is text nobody can read, so grading it would be grading
      // something that is not on the screen. They are counted and handed back so
      // the Node side can see how much of the page went this way — a walk that
      // skipped everything is the failure this whole probe exists to refuse.
      let why = null
      if (r.width === 0 || r.height === 0) why = 'not laid out (zero box)'
      else if (cs.visibility !== 'visible') why = 'visibility: ' + cs.visibility
      else if (cs.display === 'none') why = 'display: none'
      else if (fade === 0) why = 'opacity resolves to 0'
      else if (Number.parseFloat(cs.fontSize) === 0) why = 'font-size: 0'
      if (why !== null) {
        for (const site of found) skipped.push({ where, kind: site.kind, why })
        sites += found.length
        continue
      }
      const backdrop = backdropStack(el)
      const inactive = isInactive(el)
      const subject = subjectOf(el)
      for (const site of found) {
        sites += 1
        pairs.push({
          where,
          inactive,
          subject,
          kind: site.kind,
          sample: site.sample,
          inkValue: site.ink,
          // Canonicalised here for the same reason every other colour is: the
          // computed value can serialise as `oklab(...)` or `color(srgb ...)`,
          // and the Node side composites numbers, not strings.
          ink: canon(site.ink),
          inkOpacity: fade,
          fontSize: Number.parseFloat(cs.fontSize),
          fontWeight: Number.parseFloat(cs.fontWeight),
          backdrop,
        })
      }
    }
    return { sites, pairs, skipped }
  }

  /** Every element on the page that is not part of one of the probe's own rigs. */
  const pageElements = () =>
    all().filter(
      (el) =>
        el.closest('#' + RIG_ID) === null &&
        el.closest('#' + INK_RIG_ID) === null &&
        el.closest('#' + STATE_RIG_ID) === null,
    )

  function textPairs() {
    return pairsOver(pageElements())
  }

  /*
   * A second, independent count of the text this pane puts on screen, by the
   * class of element painting it.
   *
   * This exists because a floor on *how many* pairs were graded cannot see
   * proportional blinding. Drop every button on a pane that grades 63 pairs and
   * 28 are left — comfortably over any floor set with room for the fixture to
   * change — while the class of element most likely to be carrying a contrast
   * defect has silently stopped being looked at. The number that catches that is
   * not a floor, it is *coverage*: what is on the pane, against what the walk
   * came back with.
   *
   * Deliberately a separate traversal with its own filters rather than a tally
   * kept inside `textPairs`. A count taken by the walk is a count that agrees
   * with the walk by construction, and this repository has already shipped one
   * rig whose answers came from the thing it was checking. Same argument as the
   * border rig and the ink rig, one level up.
   *
   * It is also deliberately **conservative**: it counts only text nobody could
   * argue about — a non-empty child text node, a form value, a placeholder on an
   * empty field — and only where the element is genuinely on screen. Anything it
   * misses is a pair the walk may have as a bonus; anything it invents would be
   * a false failure, which is the one thing a fence must not manufacture.
   */
  function subjects() {
    const counts = {}
    for (const el of pageElements()) {
      if (el.hasAttribute('data-probe-resolver')) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (cs.visibility !== 'visible' || cs.display === 'none') continue
      if (Number.parseFloat(cs.fontSize) === 0) continue
      if (cumulativeOpacity(el) === 0) continue
      let n = 0
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.nodeValue.trim() !== '') {
          n += 1
          break
        }
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (typeof el.value === 'string' && el.value.trim() !== '') n += 1
        const ph = el.getAttribute('placeholder')
        if (ph !== null && ph.trim() !== '' && (el.value ?? '') === '') n += 1
      }
      if (n === 0) continue
      const k = subjectOf(el)
      counts[k] = (counts[k] ?? 0) + n
    }
    return counts
  }

  /*
   * The calibration rig for the compositor, and the same argument as the border
   * one: proving a counter goes red on a planted defect is only half a proof. A
   * grader that always returned 21:1 would catch nothing and keep every clean run
   * green; a grader that ignored alpha would look perfect on a page whose
   * surfaces are all opaque and be silently wrong on the ones that are not.
   *
   * So every run first grades specimens through the **same** `backdropStack` and
   * the same Node-side compositor the real page goes through. Two of them are
   * deliberately under the floor, which means each run also proves the grader
   * still knows how to say no.
   *
   * ## Where the expected answers come from, and why they moved
   *
   * They used to be worked out by hand and written into the spec table. That is
   * the failure this rig shipped: the hand arithmetic and the compositor it was
   * meant to check were written by the same reasoning, so when the compositor got
   * `opacity` group order wrong the specimens agreed with it. A rig whose answers
   * come from the model it is checking is not a rig — it is the model agreeing
   * with itself, and it stayed green through a round of the ink being composited
   * onto an already-faded backdrop.
   *
   * So each specimen now also builds two **witnesses** the caller photographs:
   *
   *  - the *ink* witness — a solid block whose `background-color` is the
   *    specimen's ink and which carries the specimen's `opacity`, sitting as a
   *    sibling of the text inside the innermost layer. Same paint, same alpha,
   *    same ancestor chain, therefore the same group compositing: its pixel is
   *    what a fully covered glyph pixel is. It is a block and not a glyph on
   *    purpose — telling a stroke pixel from a background pixel at 12px with
   *    subpixel antialiasing is its own estimator with its own error, which is
   *    exactly the thing §26.4 refused to build. `inkPaint` below is read back
   *    off the block rather than echoed, so "same paint" is checked in Node and
   *    not asserted here;
   *  - the *surface* witness — an unpainted block in the same place, so its
   *    pixels are the innermost layer composited over everything under it.
   *
   * The specimens are built from the spec the caller passes; the caller owns
   * every judgement, including which of the two answers wins when they differ.
   */
  const INK_RIG_ID = '__probe-ink-rig'

  /** A layer is a background string, or `{ bg, opacity }` when it fades its group. */
  const layerStyle = (layer) => {
    const spec = typeof layer === 'string' ? { bg: layer } : layer
    return 'background:' + spec.bg + (spec.opacity === undefined ? '' : ';opacity:' + String(spec.opacity))
  }

  function inkRig(specs) {
    inkRigClear()
    const host = document.createElement('div')
    host.id = INK_RIG_ID
    document.body.appendChild(host)
    const out = []
    specs.forEach((spec, i) => {
      // The layers, outermost first, each one nested inside the last.
      let node = document.createElement('div')
      node.setAttribute(
        'style',
        'position:fixed;left:' +
          String(8 + i * 68) +
          'px;top:120px;width:60px;height:60px;z-index:2147483646;' +
          layerStyle(spec.layers[0]),
      )
      host.appendChild(node)
      for (const layer of spec.layers.slice(1)) {
        const inner = document.createElement('div')
        inner.setAttribute('style', 'width:100%;height:100%;' + layerStyle(layer))
        node.appendChild(inner)
        node = inner
      }
      const fade = ';opacity:' + String(spec.opacity ?? 1)
      const text = document.createElement('span')
      text.setAttribute('style', 'display:block;height:16px;font-size:12px;color:' + spec.ink + fade)
      text.textContent = spec.id
      node.appendChild(text)
      // The two witnesses. The ink one wears the spec's own `opacity`, so it is
      // faded by exactly what fades the glyphs beside it.
      const inkWitness = document.createElement('div')
      inkWitness.setAttribute('style', 'display:block;height:16px;background:' + spec.ink + fade)
      node.appendChild(inkWitness)
      const surfaceWitness = document.createElement('div')
      surfaceWitness.setAttribute('style', 'display:block;height:16px')
      node.appendChild(surfaceWitness)
      const cs = getComputedStyle(text)
      out.push({
        id: spec.id,
        where: describe(text),
        // Read back through the very same measurement the page gets, never
        // echoed: a rig that reported the values it was handed would be
        // calibrating the spec instead of the code.
        ink: canon(cs.color),
        inkValue: cs.color,
        inkOpacity: cumulativeOpacity(text),
        fontSize: Number.parseFloat(cs.fontSize),
        fontWeight: Number.parseFloat(cs.fontWeight),
        backdrop: backdropStack(text),
        // For the caller to prove the witness really is painted in the ink, and
        // faded by the same amount, before it believes a pixel of it.
        inkPaint: canon(getComputedStyle(inkWitness).backgroundColor),
        inkWitnessOpacity: cumulativeOpacity(inkWitness),
        witness: { ink: rectOf(inkWitness), surface: rectOf(surfaceWitness) },
      })
    })
    return out
  }

  function inkRigClear() {
    const host = document.getElementById(INK_RIG_ID)
    if (host !== null) host.remove()
    return 'cleared'
  }

  /* ---------------------------------------------------------------- */
  /* 3b. The same page, in the states a pointer and a keyboard reach   */
  /* ---------------------------------------------------------------- */

  /*
   * Everything above measures a page **at rest**, and that is where the
   * coverage hole was: seven seeded defects walked out of the legibility check
   * and three of them were one rule gated on a state — under the pointer, under
   * the press, under the keyboard ring. Four of the pairs the source-side census
   * already records as under the floor exist **only** while hovered, and one of
   * them is on the same button whose resting label the probe was reporting as
   * the worst live text on the page.
   *
   * So the page is re-walked in each state. Three things have to be right for
   * that to mean anything, and each is answered here rather than assumed:
   *
   *  - **which elements can reach a state at all.** Forcing hover on something
   *    with no hover rule adds a pair that no user will ever see, and forcing it
   *    on a switched-off control produces a ratio WCAG 1.4.3 exempts. The
   *    subject set is therefore *derived from the artifact's own selectors*
   *    (`stateRules`), never listed by hand;
   *  - **that the state was actually entered.** `matches(':hover')` is read back
   *    off the element after the driver has done its work. A sweep that visited
   *    a state it never reached is this repository's recurring failure wearing a
   *    new coat;
   *  - **what to re-walk.** Only the subject's own subtree, and the argument for
   *    that being enough is in `stateSubjects`.
   */

  /**
   * Properties whose value decides what a reader sees.
   *
   * A `:hover` rule that only moves a transform or a shadow cannot change a
   * contrast ratio, and grading the page again for it would be spending a
   * window load to re-measure numbers that cannot have moved. `opacity` is in
   * the list because it fades ink and surface by different amounts, which is the
   * whole of §27.
   *
   * Matched against the **longhand property names the browser expanded the rule
   * into** (`rule.style[i]`), not against the declaration text: a rule written
   * `outline: 2px solid var(--color-accent)` has no substring `outline-color` in
   * it, and an earlier version of this filter missed thirteen of the fourteen
   * keyboard-ring rules for exactly that reason.
   */
  const PAINT_PROPERTY = /color$|^background|^border|^outline|^opacity$|^fill$|^stroke$/

  /** The four states, and how to spot each one in a selector without spotting the others. */
  const STATE_PATTERNS = {
    hover: /:hover(?![-\w])/g,
    active: /:active(?![-\w])/g,
    // `:focus-visible` starts with `:focus`, so the plain one needs the negative
    // lookahead or every keyboard-ring rule would be counted twice under two
    // names and the two censuses would disagree with each other.
    focus: /:focus(?![-\w])/g,
    'focus-visible': /:focus-visible(?![-\w])/g,
  }

  const STATE_NAMES = Object.keys(STATE_PATTERNS)

  /** Splits a selector list on the commas that are not inside `:is(...)` and friends. */
  function splitSelectorList(text) {
    const out = []
    let depth = 0
    let start = 0
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]
      if (c === '(' || c === '[') depth += 1
      else if (c === ')' || c === ']') depth -= 1
      else if (c === ',' && depth === 0) {
        out.push(text.slice(start, i))
        start = i + 1
      }
    }
    out.push(text.slice(start))
    return out.map((s) => s.trim()).filter((s) => s !== '')
  }

  /**
   * Whether the state pseudo-class is worn by the element the rule paints, or by
   * an ancestor of it.
   *
   * `.a:hover .b` paints `.b` while `.a` is hovered; `.b:hover` paints `.b`
   * while `.b` is. The distinction decides whether a driver that sets the state
   * on one element is enough, and `probe-main.mjs` refuses to drive a state
   * whose selectors need the other shape rather than quietly getting it wrong.
   *
   * A state pseudo inside parentheses — the compiled `group-hover` shape is
   * `:is(:where(.group):hover *)` — counts as ancestor-borne, because it is: the
   * `:hover` belongs to `.group` and the rule paints its descendant. Treating
   * "inside a functional pseudo" as ancestor-borne is deliberately the cautious
   * reading; the cost of being wrong that way is a driver that does more work
   * than it had to, and the cost of the other way is a state nobody entered.
   */
  function stateIsAncestorBorne(sel, pattern) {
    let depth = 0
    let lastCombinator = -1
    for (let i = 0; i < sel.length; i += 1) {
      const c = sel[i]
      if (c === '(' || c === '[') depth += 1
      else if (c === ')' || c === ']') depth -= 1
      else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) lastCombinator = i
    }
    pattern.lastIndex = 0
    let m
    let ancestorBorne = false
    while ((m = pattern.exec(sel)) !== null) {
      // Inside parentheses, or in any compound but the last one.
      let d = 0
      for (let i = 0; i < m.index; i += 1) {
        const c = sel[i]
        if (c === '(' || c === '[') d += 1
        else if (c === ')' || c === ']') d -= 1
      }
      if (d > 0 || m.index < lastCombinator) ancestorBorne = true
    }
    pattern.lastIndex = 0
    return ancestorBorne
  }

  /**
   * Every rule in the shipped stylesheet that paints something in a state, and
   * the selector that finds the elements it paints.
   *
   * The de-stated selector — the rule's own selector with the state pseudo
   * simply deleted — is the whole trick, and it is worth spelling out why it is
   * the right subject set rather than a convenient one:
   *
   *   `X:hover` de-states to `X`, so the subject *is* the element the rule
   *   paints. `.a:hover .b` de-states to `.a .b`, so the subject is `.b` — the
   *   element the rule paints — and hovering `.b` hovers `.a` too, because the
   *   browser puts `:hover` on the whole ancestor chain. Either way, **hovering
   *   the matched element is what makes that rule apply to it.**
   *
   * So there is no host/descendant bookkeeping to get wrong, and no selector
   * surgery beyond a deletion. A de-stated selector the browser will not parse
   * is reported rather than skipped: `:not(:hover)` would deletion-collapse to
   * `:not()`, which is a real (if hypothetical) shape and must not silently cost
   * the sweep a rule.
   */
  function stateRules() {
    const out = {}
    for (const name of STATE_NAMES) out[name] = []
    const seen = {}
    for (const name of STATE_NAMES) seen[name] = new Set()
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules !== undefined && rule.cssRules !== null) walk(rule.cssRules)
        if (rule.selectorText === undefined || rule.style === undefined) continue
        let paints = false
        for (let i = 0; i < rule.style.length; i += 1) {
          if (PAINT_PROPERTY.test(rule.style[i])) paints = true
        }
        if (!paints) continue
        for (const sel of splitSelectorList(rule.selectorText)) {
          for (const name of STATE_NAMES) {
            const pattern = STATE_PATTERNS[name]
            // A `:focus-visible` selector is not a `:focus` selector. Without
            // this the keyboard-ring rules would be counted under both names.
            if (name === 'focus' && /:focus-visible/.test(sel)) continue
            pattern.lastIndex = 0
            if (!pattern.test(sel)) continue
            pattern.lastIndex = 0
            const de = sel.replace(pattern, '')
            if (seen[name].has(sel)) continue
            seen[name].add(sel)
            out[name].push({ sel, de, ancestorBorne: stateIsAncestorBorne(sel, pattern) })
          }
        }
      }
    }
    walk(document.styleSheets[0].cssRules)
    return out
  }

  /** Elements the state sweep will visit, per state. Index is the address. */
  const stateSubjectEls = {}

  /**
   * The elements on **this pane** that can reach one state, with the reasons a
   * candidate was dropped kept rather than thrown away.
   *
   * Two exclusions, both deliberate and both stated in §28 of the record:
   *
   *  - anything not on screen. A state on a zero-box element paints nothing and
   *    a ratio off it is a ratio nobody can see;
   *  - anything **switched off**. WCAG 2.1 SC 1.4.3 exempts an inactive
   *    component, and this app's disabled controls are already excused at rest,
   *    per state, by `isInactive`. Forcing hover onto one and then grading the
   *    result would manufacture a breach out of an exemption — and it would do
   *    it in the flattering-to-the-fence direction, which is the worst kind.
   *
   * The excluded ones are counted and returned, so "the sweep looked at nothing
   * because it excluded everything" is a number somebody can read rather than a
   * silence.
   */
  function stateSubjects(state) {
    const rules = stateRules()[state] ?? []
    const els = new Set()
    const badSelectors = []
    for (const r of rules) {
      try {
        for (const el of document.querySelectorAll(r.de)) els.add(el)
      } catch (err) {
        badSelectors.push({ sel: r.sel, de: r.de, why: String(err && err.message ? err.message : err) })
      }
    }
    let offScreen = 0
    let inactiveOut = 0
    const live = []
    for (const el of els) {
      if (el.closest('#' + RIG_ID) !== null) continue
      if (el.closest('#' + INK_RIG_ID) !== null) continue
      if (el.closest('#' + STATE_RIG_ID) !== null) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || cs.visibility !== 'visible' || cs.display === 'none') {
        offScreen += 1
        continue
      }
      if (isInactive(el)) {
        inactiveOut += 1
        continue
      }
      live.push(el)
    }
    stateSubjectEls[state] = live
    const attr = 'data-probe-subject-' + state
    live.forEach((el, i) => {
      el.setAttribute(attr, String(i))
    })
    return {
      state,
      ruleCount: rules.length,
      ancestorBorne: rules.filter((r) => r.ancestorBorne).map((r) => r.sel),
      badSelectors,
      offScreen,
      inactive: inactiveOut,
      subjects: live.map((el, i) => ({
        index: i,
        uid: uidOf(el),
        where: describe(el),
        subject: subjectOf(el),
        rect: rectOf(el),
      })),
    }
  }

  /**
   * Puts one subject where a real pointer can be moved onto it, and says where.
   *
   * A pane taller than its window has controls below the fold, and a pointer
   * cannot be dispatched to a point outside the viewport. Scrolling is what a
   * user does to reach them; the alternative — skipping them — is a third of a
   * pane quietly not being hovered, which is exactly the failure `subjects()`
   * was added for one round ago.
   */
  function stateAim(index) {
    const el = stateSubjectEls.hover[index]
    if (el === undefined) return { ok: false, why: 'no hover subject at index ' + String(index) }
    let r = el.getBoundingClientRect()
    const outside = r.top < 0 || r.left < 0 || r.bottom > window.innerHeight || r.right > window.innerWidth
    if (outside) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      r = el.getBoundingClientRect()
    }
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const reachable = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
    return { ok: true, x, y, reachable, scrolled: outside, where: describe(el), rect: rectOf(el) }
  }

  /**
   * The subject's subtree, walked while the state is on it, plus the read-back
   * that says the state is really on it.
   *
   * The subtree and not the page: a state rule can only repaint an element that
   * some `:state` selector names, every such element is itself in the subject
   * set (that is what `stateRules` derives), and visiting subject X walks X and
   * everything inside it. So every element a state rule can repaint is walked at
   * least once with that rule applying. Walking the whole page for every subject
   * would re-measure the same resting numbers twenty-five times over and cost
   * the run seconds to learn nothing.
   *
   * `hit` is here for the pointer: a subject the pointer cannot actually land on
   * — something painted over it — would report `matched: false`, and the hit
   * says which element got the pointer instead, so the failure names a cause.
   */
  function stateRead(index, state) {
    const el = stateSubjectEls[state]?.[index]
    if (el === undefined) return { ok: false, why: 'no ' + state + ' subject at index ' + String(index) }
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    const walked = pairsOver([el, ...el.querySelectorAll('*')])
    return {
      ok: true,
      where: describe(el),
      matched: el.matches(':' + state),
      hit: at === null ? null : describe(at),
      hitIsSelf: at !== null && (at === el || el.contains(at)),
      hasFocus: document.hasFocus(),
      ...walked,
    }
  }

  /**
   * Whatever holds focus now, walked the same way a hover subject is.
   *
   * The keyboard ring is driven from Node by real Tab keystrokes, so this is the
   * read-back half: which element the ring landed on, whether it is one of the
   * elements the artifact has a focus rule for, and whether the two focus
   * pseudo-classes actually match. `:focus-visible` is reported separately from
   * `:focus` because they are different predicates and this app styles the ring
   * off the stricter one — a sweep that satisfied `:focus` and not
   * `:focus-visible` would grade a page with no ring on it and call it covered.
   */
  function focusHere() {
    const el = document.activeElement
    if (el === null || el === document.body || el === document.documentElement) {
      return { ok: false, why: 'nothing holds focus', hasFocus: document.hasFocus() }
    }
    const subjectIndex = {}
    for (const state of ['focus', 'focus-visible']) {
      const v = el.getAttribute('data-probe-subject-' + state)
      subjectIndex[state] = v === null ? null : Number(v)
    }
    const walked = pairsOver([el, ...el.querySelectorAll('*')])
    return {
      ok: true,
      uid: uidOf(el),
      where: describe(el),
      tag: el.tagName.toLowerCase(),
      subjectIndex,
      matchesFocus: el.matches(':focus'),
      matchesFocusVisible: el.matches(':focus-visible'),
      hasFocus: document.hasFocus(),
      inactive: isInactive(el),
      ...walked,
    }
  }

  /**
   * Forces the whole document's style to be recomputed, and hands back proof
   * that it was.
   *
   * Releasing a forced pseudo-class over CDP clears the flag — `matches(':active')`
   * says no immediately — but it does **not** invalidate style, and every
   * computed value stays at what the forced state painted until something else
   * dirties the tree. Measured, and it cost a sweep: with the flag released and
   * `matches` saying no, `getComputedStyle(button).backgroundColor` was still the
   * pressed colour, so the next sweep's resting readings were the *pressed*
   * page and every one of its pairs came back "repainted by the state".
   *
   * A custom property on the root is the invalidation, because a `var()`
   * dependency reaches everything: the whole subtree is dirtied whatever the
   * selectors look like, which an unused attribute or class is not guaranteed to
   * do. It is set and removed inside one function so the page is never left
   * carrying it, and a computed value is read in between to force the recalc
   * rather than merely schedule it.
   */
  function restyle() {
    const root = document.documentElement
    root.style.setProperty('--probe-restyle', '1')
    const forced = getComputedStyle(document.body).color
    root.style.removeProperty('--probe-restyle')
    return { restyled: true, sample: forced }
  }

  /** Drops focus so the ring can be walked from its beginning, deterministically. */
  function focusReset() {
    const el = document.activeElement
    if (el !== null && typeof el.blur === 'function') el.blur()
    return { hasFocus: document.hasFocus(), active: describe(document.activeElement ?? document.body) }
  }

  /*
   * The calibration rig for the state sweep.
   *
   * Same argument as the two rigs above it, one level along: proving the sweep
   * goes red on a planted state defect shows it can catch something, and shows
   * nothing about whether the numbers it reports are the *state's* numbers. A
   * driver that dispatched its pointer into the void and a grader that quietly
   * re-read the resting colours would agree on a clean page, every time, and the
   * three plants would still go red — because a plant makes the resting colours
   * bad too if the driver never leaves rest.
   *
   * So each specimen declares two colour pairs — one at rest, one in the state —
   * chosen so that **the two ratios are far apart and one of them breaches the
   * floor**. The caller then asserts three things: the grader read the state's
   * pair, not the resting one; the grader's colours are the colours the
   * framebuffer photographed; and the ratio is the one pinned from a previous
   * photograph.
   *
   * The rules live in an **adopted** stylesheet rather than a `<style>` element,
   * measured for the reason: a `<style>` would make `document.styleSheets.length`
   * two and the `sanity` check asserts it is exactly one. Adopted sheets do not
   * appear in `document.styleSheets` (checked on this Chromium: the count stayed
   * 1 with one adopted), so the rig cannot make the fail-closed gate lie.
   *
   * The host is inserted as the **first** child of `body` so the specimen that
   * has to be focused is the first stop in the tab ring — one keystroke instead
   * of tabbing past a whole pane to reach it.
   */
  const STATE_RIG_ID = '__probe-state-rig'

  function stateRig(specs) {
    stateRigClear()
    const host = document.createElement('div')
    host.id = STATE_RIG_ID
    const sheet = new CSSStyleSheet()
    const css = []
    specs.forEach((spec, i) => {
      const s = '#' + STATE_RIG_ID + ' .' + spec.id
      css.push(
        s +
          '{position:fixed;left:' +
          String(8 + i * 68) +
          'px;top:200px;width:60px;height:64px;z-index:2147483645;outline:none;background:' +
          spec.rest.bg +
          '}',
        s + ' .t{display:block;height:16px;font-size:12px;color:' + spec.rest.ink + '}',
        s + ' .w{display:block;height:16px;background:' + spec.rest.ink + '}',
        s + ' .u{display:block;height:16px}',
        s + ':' + spec.state + '{background:' + spec.on.bg + '}',
        s + ':' + spec.state + ' .t{color:' + spec.on.ink + '}',
        s + ':' + spec.state + ' .w{background:' + spec.on.ink + '}',
      )
      const box = document.createElement('div')
      box.className = spec.id
      // Focusable, because one of the three states is only reachable by the
      // keyboard and a plain div is not in the tab ring.
      box.setAttribute('tabindex', '0')
      const text = document.createElement('span')
      text.className = 't'
      text.textContent = spec.id
      const ink = document.createElement('div')
      ink.className = 'w'
      const surface = document.createElement('div')
      surface.className = 'u'
      box.append(text, ink, surface)
      host.appendChild(box)
    })
    sheet.replaceSync(css.join('\n'))
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
    document.body.insertBefore(host, document.body.firstChild)
    return stateRigRead(specs)
  }

  /**
   * Reads every specimen the same way the real page is read — through
   * `backdropStack` and `inkSites` — and hands back the witness rectangles for
   * the caller to photograph. Called once before the states are entered and
   * once after, so "the grader read the state's colours" is a comparison of two
   * readings rather than an assertion about one.
   */
  function stateRigRead(specs) {
    const host = document.getElementById(STATE_RIG_ID)
    if (host === null) return []
    return specs.map((spec) => {
      const box = host.querySelector('.' + spec.id)
      const text = box.querySelector('.t')
      const inkWitness = box.querySelector('.w')
      const surfaceWitness = box.querySelector('.u')
      const cs = getComputedStyle(text)
      return {
        id: spec.id,
        state: spec.state,
        where: describe(text),
        matched: box.matches(':' + spec.state),
        ink: canon(cs.color),
        inkValue: cs.color,
        inkOpacity: cumulativeOpacity(text),
        fontSize: Number.parseFloat(cs.fontSize),
        fontWeight: Number.parseFloat(cs.fontWeight),
        backdrop: backdropStack(text),
        inkPaint: canon(getComputedStyle(inkWitness).backgroundColor),
        inkWitnessOpacity: cumulativeOpacity(inkWitness),
        boxRect: rectOf(box),
        focused: document.activeElement === box,
        witness: { ink: rectOf(inkWitness), surface: rectOf(surfaceWitness) },
      }
    })
  }

  /**
   * Focuses one specimen of the state rig, and reports what the browser made of
   * it rather than what the caller hoped.
   *
   * Programmatic, and the caller sends a real keystroke immediately before —
   * which is not a workaround for the lesson that `.focus()` does not satisfy
   * `:focus-visible`, it is that lesson applied. Two of this probe's four panes
   * are modal dialogs whose focus trap consumes **every** Tab and puts focus
   * back inside the dialog, so a rig outside the dialog can never be reached by
   * tabbing; and a `position: fixed` box has a null `offsetParent`, so the trap
   * would not accept it as a stop even if the rig were moved inside. What the
   * caller asserts is the read-back below, which is the predicate that mattered
   * in the first place.
   */
  function stateRigFocus(id) {
    const host = document.getElementById(STATE_RIG_ID)
    if (host === null) return { ok: false, why: 'the state rig is not on the page' }
    const box = host.querySelector('.' + id)
    if (box === null) return { ok: false, why: 'no specimen named ' + id }
    box.focus()
    return {
      ok: true,
      focused: document.activeElement === box,
      matchesFocus: box.matches(':focus'),
      matchesFocusVisible: box.matches(':focus-visible'),
      hasFocus: document.hasFocus(),
    }
  }

  function stateRigClear() {
    const host = document.getElementById(STATE_RIG_ID)
    if (host !== null) host.remove()
    // Only the rig's own sheets go; anything else adopted is not this file's.
    document.adoptedStyleSheets = []
    return 'cleared'
  }

  /* ---------------------------------------------------------------- */
  /* 4. Motion at rest                                                 */
  /* ---------------------------------------------------------------- */

  /*
   * Pseudo-elements are swept too. Half this app's motion is a `::before` or an
   * `::after`, and a reduced-motion override that missed one would read clean
   * from the element side.
   */
  function motion() {
    const out = []
    for (const el of all()) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo)
        const names = cs.animationName.split(',').map((s) => s.trim())
        const durations = cs.animationDuration.split(',').map((s) => s.trim())
        names.forEach((name, i) => {
          if (name === 'none') return
          out.push({
            where: describe(el) + (pseudo ?? ''),
            name,
            duration: durations[i] ?? durations[0],
            iterations: cs.animationIterationCount,
          })
        })
      }
    }
    return { matchesReduce: matchMedia('(prefers-reduced-motion: reduce)').matches, animations: out }
  }

  /* ---------------------------------------------------------------- */
  /* 5. Borders that claim to be two lines                             */
  /* ---------------------------------------------------------------- */

  /*
   * `border-style: double` is three bands — line, gap, line — and CSS gives the
   * gap whatever is left after two 1px lines. Under 3px there is nothing left,
   * so the browser paints **one solid line** and the declaration is a lie that
   * every keyword-reading check believes.
   *
   * This reports the geometry; `probe-main.mjs` both applies the 3px rule and
   * counts the bands in a real capture, because the pixels are the part the
   * keyword cannot say.
   */
  function doubleBorders() {
    const out = []
    for (const el of all()) {
      if (el.closest('#' + RIG_ID) !== null) continue
      const cs = getComputedStyle(el)
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (cs['border' + side + 'Style'] !== 'double') continue
        out.push({
          where: describe(el),
          side: side.toLowerCase(),
          width: Number.parseFloat(cs['border' + side + 'Width']),
          colour: cs['border' + side + 'Color'],
          rect: rectOf(el),
        })
      }
    }
    return out
  }

  /*
   * The calibration rig for the band counter, and the reason it has to exist.
   *
   * This app ships **no** double borders at all (`grep -c double` over the
   * artifact: 0), so the band counter has no natural subject and a normal run
   * never exercises it. That is a specific, nasty trap: a counter that always
   * reported "one line" would still catch `--plant=double-border`, and would
   * still leave a clean run green — a fence that is red in the one place anybody
   * checks it and blind everywhere else. Proving it goes red is only half a
   * proof; something must also prove it goes **green on a genuine two-line
   * border**, or "1 band" is unfalsifiable.
   *
   * So `probe-main.mjs` builds a border it already knows the answer for — 3px,
   * which is the narrowest width where line + gap + line each get a whole pixel
   * — and requires the counter to see two lines in it. Only then is that same
   * counter trusted on the real page.
   *
   * Colours come from `var()` on the product's own theme rather than literals:
   * the rig is torn down in a `finally` before anything else looks at the page,
   * but if a future reordering ever ran the colour sweep while it was up, a rig
   * painted in the app's own palette fails no check, whereas two invented hex
   * literals would fail the palette sweep and the failure would look like a real
   * defect. Belt and braces, cheap.
   */
  const RIG_ID = '__probe-border-rig'

  function borderRig(specs) {
    borderRigClear()
    const host = document.createElement('div')
    host.id = RIG_ID
    document.body.appendChild(host)
    const out = []
    specs.forEach((spec, i) => {
      const el = document.createElement('div')
      // `position: fixed` and z-index at the ceiling so the rig is on top of
      // whatever the pane happens to be, and so its rect is a viewport rect —
      // which is the coordinate space `capturePage` takes.
      el.setAttribute(
        'style',
        'position:fixed;left:' +
          String(20 + i * 90) +
          'px;top:20px;width:60px;height:60px;box-sizing:border-box;z-index:2147483647;' +
          'background:var(--color-bg);border-color:var(--color-fg);border-style:' +
          spec.style +
          ';border-width:' +
          String(spec.width) +
          'px',
      )
      host.appendChild(el)
      const cs = getComputedStyle(el)
      out.push({
        id: spec.id,
        // Read back, not echoed: the whole question is what the browser did with
        // the declaration, and a rig that reported the value it was handed would
        // be assuming the answer.
        style: cs.borderTopStyle,
        width: Number.parseFloat(cs.borderTopWidth),
        colour: cs.borderTopColor,
        background: cs.backgroundColor,
        rect: rectOf(el),
      })
    })
    return out
  }

  function borderRigClear() {
    const host = document.getElementById(RIG_ID)
    if (host !== null) host.remove()
    return 'cleared'
  }

  /* ---------------------------------------------------------------- */
  /* 6. Native form controls, and where the UA paints them             */
  /* ---------------------------------------------------------------- */

  /*
   * `accent-color: auto` is a colour with no author behind it: the user agent
   * picks it from the document's `color-scheme`, and it appears in no
   * stylesheet, no class string and no bundle. The only way to see it is to look
   * at the pixels, so this hands back rectangles and the caller captures them.
   *
   * An unchecked checkbox paints **no accent at all** — in a dark scheme it is a
   * flat grey box — so the accent measurement is only meaningful on a checked
   * one, and getting it checked is fiddlier than it looks.
   *
   * Assigning `el.checked = true` is what this did first, and it measured
   * rgb(59,59,59) at 1.49:1: Chromium's dark-scheme *unchecked* fill. These are
   * React-**controlled** inputs whose `checked` prop is bound to component
   * state, and React restores the DOM property from that state, so the
   * assignment was gone before the capture. `.click()` instead goes through the
   * product's own `onChange`, React's state actually becomes `true`, and the
   * control stays checked across every later render.
   *
   * The direct assignment is kept only as a fallback for a control whose click
   * something swallowed, and either way the real `checked` is reported back so
   * `probe-main.mjs` can refuse to judge a control that never got checked rather
   * than quietly measuring an empty box.
   */
  function controls() {
    const out = []
    const nodes = document.querySelectorAll(
      'input[type=checkbox], input[type=radio], input[type=range], select, input[type=number], input[type=password]',
    )
    for (const el of nodes) {
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        if (!el.checked) el.click()
        if (!el.checked) el.checked = true
      }
      const cs = getComputedStyle(el)
      out.push({
        where: describe(el),
        kind: el.tagName.toLowerCase() + (el instanceof HTMLInputElement ? ':' + el.type : ''),
        accentColor: cs.accentColor,
        // Read back, never assumed: an unchecked control paints no accent, and a
        // check that measured one would be measuring the empty box.
        checked: el instanceof HTMLInputElement ? el.checked : null,
        rect: rectOf(el),
        surface: surfaceBehind(el),
      })
    }
    return out
  }

  /** The nearest ancestor that actually paints a background — what the control sits on. */
  function surfaceBehind(el) {
    let node = el.parentElement
    while (node !== null) {
      const c = canon(getComputedStyle(node).backgroundColor)
      if (c !== null && c[3] !== 0)
        return { where: describe(node), value: getComputedStyle(node).backgroundColor }
      node = node.parentElement
    }
    return { where: 'body', value: getComputedStyle(document.body).backgroundColor }
  }

  /*
   * Forces the document's colour scheme, for the one measurement that has to
   * compare two of them.
   *
   * Setting it on `document.documentElement.style` is the second channel this
   * probe exists to watch, used deliberately: an inline `style` outranks the
   * stylesheet, so this really does replace whatever `:root` declared, and the
   * difference between the two captures is a **pixel-level proof that the
   * declaration reaches the user agent**. Always restored by the caller.
   */
  function forceScheme(value) {
    document.documentElement.style.colorScheme = value
    return getComputedStyle(document.documentElement).colorScheme
  }

  function releaseScheme() {
    document.documentElement.style.removeProperty('color-scheme')
    return getComputedStyle(document.documentElement).colorScheme
  }

  /* ---------------------------------------------------------------- */
  /* 7. Can the user actually press it?                                */
  /* ---------------------------------------------------------------- */

  /*
   * Three different failures wear the same clothes — a control that is off the
   * bottom of a short window, a control clipped by an `overflow: hidden`
   * ancestor, and a control with something painted over it — and all three end
   * with a user who cannot answer a blocking dialog.
   *
   * `elementFromPoint` is the only one of the three that is not a rectangle
   * comparison, and it is the one that catches the overlay.
   */
  function hitTest(selector) {
    return hitTestEl(document.querySelector(selector), selector)
  }

  /*
   * The same measurement, aimed at whatever holds initial focus.
   *
   * This is how the consent dialog's Accept is addressed, and the indirection
   * earns its keep: `ConsentDialog` passes `initialFocus: acceptRef` to
   * `useModalDialog`, so "the initially focused element" *is* Accept by the
   * product's own contract. Every other way of naming it is worse — its label is
   * translated, so a text selector would need one spelling per locale and this
   * check runs in two; and its class comes from the button variant table, so a
   * class selector would silently start matching nothing the day that table is
   * restyled, which is the failure this whole probe exists to refuse.
   *
   * `document.activeElement` rather than the `:focus` pseudo-class: these
   * windows are never shown, and `:focus` does not match in a document whose
   * window is not focused, while `activeElement` still names the element.
   */
  function hitTestActive() {
    const el = document.activeElement
    const naming = 'the initially focused element'
    if (el === null || el === document.body || el === document.documentElement) {
      return { found: false, selector: naming }
    }
    return hitTestEl(el, naming)
  }

  function hitTestEl(el, selector) {
    if (el === null) return { found: false, selector }
    const r = el.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    const at = document.elementFromPoint(cx, cy)
    let clippedBy = null
    let node = el.parentElement
    while (node !== null && clippedBy === null) {
      const cs = getComputedStyle(node)
      if (cs.overflow !== 'visible' || cs.overflowY !== 'visible' || cs.overflowX !== 'visible') {
        const pr = node.getBoundingClientRect()
        if (
          r.top < pr.top - 0.5 ||
          r.bottom > pr.bottom + 0.5 ||
          r.left < pr.left - 0.5 ||
          r.right > pr.right + 0.5
        ) {
          clippedBy = { where: describe(node), rect: rectOf(node) }
        }
      }
      node = node.parentElement
    }
    return {
      found: true,
      selector,
      where: describe(el),
      text: (el.textContent ?? '').trim().slice(0, 40),
      rect: rectOf(el),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      inViewport:
        r.top >= -0.5 &&
        r.left >= -0.5 &&
        r.bottom <= window.innerHeight + 0.5 &&
        r.right <= window.innerWidth + 0.5,
      hit: at === null ? null : describe(at),
      hitIsSelf: at !== null && (at === el || el.contains(at)),
      clippedBy,
      disabled: el instanceof HTMLButtonElement ? el.disabled : null,
      tag: el.tagName.toLowerCase(),
    }
  }

  /*
   * Waits for what was just changed to actually be on screen.
   *
   * `capturePage` photographs the compositor's most recent frame, not the DOM.
   * Checking a checkbox and capturing it in the next IPC round trip returned the
   * frame from *before* the click — measured: a control reporting `checked ===
   * true` photographed as rgb(59,59,59), Chromium's dark-scheme **unchecked**
   * fill, at 1.49:1. Nothing was wrong with the DOM; the picture was simply old.
   *
   * Two frames for the same reason `fixture.tsx` waits two: one for style and
   * layout, one for the paint that produced. This resolves a promise, and
   * `executeJavaScript` awaits it, so the Node side genuinely blocks on the
   * frame rather than sleeping for a guessed number of milliseconds.
   */
  function settle() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve('settled')
        })
      })
    })
  }

  document.documentElement.appendChild(resolver)

  globalThis.__probe = {
    settle,
    sanity,
    colours,
    motion,
    textPairs,
    subjects,
    inkRig,
    inkRigClear,
    stateRules,
    stateSubjects,
    stateAim,
    stateRead,
    focusHere,
    focusReset,
    restyle,
    stateRig,
    stateRigRead,
    stateRigFocus,
    stateRigClear,
    doubleBorders,
    borderRig,
    borderRigClear,
    controls,
    forceScheme,
    releaseScheme,
    hitTest,
    hitTestActive,
    canon: (v) => canon(v),
  }
  return 'ok'
})()
