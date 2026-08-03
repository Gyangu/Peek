import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { decomment, openingTags, stylesheets } from '../../__tests__/sourceScan'
import {
  ACTION_ID_PATTERN,
  BUTTON_MODIFIER_NAMES,
  CONTROL_SIZE_NAMES,
  BUTTON_VARIANTS,
  BUTTON_VARIANT_NAMES,
  CONTROL_STATE_NAMES,
  LAYOUT_ONLY_PROPERTIES,
  MENU_ITEM_CLASS,
  MENU_TONE_NAMES,
  menuStateSelector,
  menuToneClass,
  sizeClass,
  stateSelector,
  type ButtonVariant,
  type ControlState,
} from '../spec'

/* ==================================================================
 * The control spec, as executable rules.
 *
 * Every rule in `spec.ts` that can be checked mechanically is checked here.
 * That distinction is the whole point of the file: a coding agent never gets a
 * code review, so a convention that only lives in prose is a convention that
 * does not apply to half the authors of this codebase. **If it is not in CI, it
 * is not a rule.**
 *
 * Every failure message below is written to say what to do next, not merely what
 * went wrong. An agent's one reliable channel for learning a codebase's rules is
 * the error it just hit; a message that only says `assertion failed` wastes it.
 *
 * Design record: docs/design/2026-08-02-control-spec.md §2.8
 * ================================================================== */

const UI = join(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(UI, '..')

const STYLESHEETS = stylesheets(RENDERER)

const DOC = 'docs/design/2026-08-02-control-spec.md'
const GUIDE = 'apps/desktop/src/renderer/ui/CLAUDE.md'

/* ------------------------------------------------------------------
 * Reading the sources
 * ------------------------------------------------------------------ */

function tsxFiles(): string[] {
  const out: string[] = []
  for (const entry of readdirSync(RENDERER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
    out.push(join(entry.parentPath, entry.name))
  }
  return out.sort()
}

interface Rule {
  selectors: string[]
  properties: string[]
}

function rules(css: string): Rule[] {
  const out: Rule[] = []
  for (const m of decomment(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const properties = [...m[2].matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((p) => p[2])
    if (selectors.length > 0) out.push({ selectors, properties })
  }
  return out
}

interface Usage {
  file: string
  attrs: string
}

function buttonUsages(): Usage[] {
  const out: Usage[] = []
  for (const path of tsxFiles()) {
    const src = readFileSync(path, 'utf8')
    for (const attrs of openingTags(src, 'Button')) out.push({ file: relative(RENDERER, path), attrs })
  }
  return out
}

/** The value of a static `name="..."` attribute, if there is one. */
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]
}

/* ------------------------------------------------------------------
 * 0 — the checker itself
 *
 * Every rule below is only as true as the scanner that feeds it, and that
 * scanner shipped with a hole: it matched tag names on raw source and only began
 * tracking comments *after* a match, so a `<button>` written in prose counted as
 * an element. Testing the test is not ceremony here — it is the difference
 * between a boundary and the appearance of one.
 * ------------------------------------------------------------------ */

describe('the scanner reads code, not prose', () => {
  const FIXTURE = [
    '/**',
    ' * A `div` with role="tab" rather than a `<button>`, for a plain HTML reason.',
    ' */',
    'export function X() {',
    '  // A bare <button> here would bypass the spec.',
    '  const help = "write <Button variant=\\"danger\\"> instead"',
    '  return (',
    '    <Button variant="danger" action="conn.forget">',
    '      {/* <button> in a JSX comment */}',
    '      Remove',
    '    </Button>',
    '  )',
    '}',
  ].join('\n')

  test('a tag named in a comment or a string is not an element', () => {
    assert.deepEqual(
      openingTags(FIXTURE, 'button'),
      [],
      'prose mentioning <button> was counted as a bare button — the migration ledger can then ' +
        'never shrink past it, and a file that is fully migrated stays exempt for good',
    )
    assert.equal(
      openingTags(FIXTURE, 'Button').length,
      1,
      'exactly one real <Button> is present; a comment and a string literal also name one',
    )
  })

  test('attribute values survive the blanking', () => {
    // The scan runs over a blanked copy but slices from the original. Getting
    // this backwards is silent: every `action` and `exposure` reads as empty,
    // every assertion about them passes, and nothing anywhere reports a problem.
    const [attrs] = openingTags(FIXTURE, 'Button')
    assert.equal(attr(attrs, 'variant'), 'danger')
    assert.equal(attr(attrs, 'action'), 'conn.forget')
  })

  test('the permission boundary cannot be satisfied by a sentence', () => {
    // The tripwire asserts PermissionPrompt still renders a <Button>. If prose
    // counted, reverting the file to bare <button> while leaving a comment that
    // mentions <Button> would keep every check in this file green — including
    // the one that stops an agent being handed its own approval dialog.
    const decoy = '// this file used to render <Button exposure="agent-ok"> here\nconst x = 1\n'
    assert.deepEqual(openingTags(decoy, 'Button'), [])
  })
})

/* ------------------------------------------------------------------
 * 1 & 2 — the spec and the stylesheet agree
 * ------------------------------------------------------------------ */

describe('the spec is complete in itself', () => {
  test('every variant states an intent', () => {
    for (const name of BUTTON_VARIANT_NAMES) {
      const { intent } = BUTTON_VARIANTS[name]
      assert.ok(
        intent.trim().length > 20,
        `Variant "${name}" has no usable \`intent\`.\n` +
          `\`intent\` is the sentence an agent reads to choose this variant over the others — ` +
          `it is not documentation garnish. A variant nobody can describe in one line is a variant ` +
          `named after its colour, which is what ${DOC} §1.5 exists to prevent.`,
      )
    }
  })
})

describe('controls.css covers the whole matrix', () => {
  const css = readFileSync(join(UI, 'controls.css'), 'utf8')
  const selectors = new Set(rules(css).flatMap((r) => r.selectors))

  for (const variant of BUTTON_VARIANT_NAMES) {
    test(`${variant} defines all ${CONTROL_STATE_NAMES.length} states`, () => {
      const missing = CONTROL_STATE_NAMES.filter((state) => !selectors.has(stateSelector(variant, state)))
      assert.deepEqual(
        missing,
        [],
        `Variant "${variant}" is missing ${missing.length} state(s): ${missing.join(', ')}.\n` +
          `Add to ui/controls.css:\n` +
          missing.map((s) => `  ${stateSelector(variant, s)} { … }`).join('\n') +
          `\n\nA variant with no \`:active\` gives no feedback when pressed, and one with no ` +
          `\`:hover\` falls back to the base grey mid-gesture — a danger button that stops looking ` +
          `dangerous exactly while the pointer is on it. Half a variant is why this test exists.`,
      )
    })
  }

  test('both sizes exist', () => {
    for (const size of CONTROL_SIZE_NAMES) {
      assert.ok(
        selectors.has(`.${sizeClass(size)}`),
        `Size "${size}" is declared in spec.ts but .${sizeClass(size)} has no rule in ui/controls.css.`,
      )
    }
  })

  test('no stray .btn-* class exists outside the spec', () => {
    const declared = new Set<string>([
      'btn',
      ...BUTTON_MODIFIER_NAMES,
      ...BUTTON_VARIANT_NAMES.map((v) => `btn-${v}`),
      ...CONTROL_SIZE_NAMES.map((s) => `btn-${s}`),
    ])
    const stray = new Set<string>()
    for (const sheet of STYLESHEETS) {
      for (const rule of rules(readFileSync(join(RENDERER, sheet), 'utf8'))) {
        for (const selector of rule.selectors) {
          for (const m of selector.matchAll(/\.(btn[a-zA-Z0-9_-]*)/g)) {
            if (!declared.has(m[1])) stray.add(`${sheet} → .${m[1]}`)
          }
        }
      }
    }
    assert.deepEqual(
      [...stray],
      [],
      `These .btn-* classes are styled but not declared in spec.ts:\n${[...stray].join('\n')}\n\n` +
        `A class in the control layer's namespace that the spec does not know about is a variant ` +
        `invented locally — the exact failure ${DOC} §1.2 documents. Declare it in BUTTON_VARIANTS ` +
        `(with an intent, and all five states) or give it a name outside the btn- namespace.`,
    )
  })
})

describe('menu.css covers the whole tone matrix', () => {
  /*
   * The same contract `controls.css` is held to, for the other primitive.
   *
   * `<Menu>`'s lines are not `<Button>`s — a menu item undoes almost everything
   * `.btn` declares — so they get their own two-value scale (`MENU_TONES`) and
   * their own stylesheet. What does *not* change is the completeness rule: a
   * tone that defines three of the five states is half a tone, and the missing
   * halves are always `:active` and `:focus-visible`, which are exactly the two
   * nobody notices until a keyboard user cannot see where they are.
   */
  const css = readFileSync(join(UI, 'menu.css'), 'utf8')
  const selectors = new Set(rules(css).flatMap((r) => r.selectors))

  for (const tone of MENU_TONE_NAMES) {
    test(`${tone} defines all ${CONTROL_STATE_NAMES.length} states`, () => {
      const missing = CONTROL_STATE_NAMES.filter((state) => !selectors.has(menuStateSelector(tone, state)))
      assert.deepEqual(
        missing,
        [],
        `Menu tone "${tone}" is missing ${missing.length} state(s): ${missing.join(', ')}.\n` +
          `Add to ui/menu.css:\n` +
          missing.map((state) => `  ${menuStateSelector(tone, state)} { … }`).join('\n'),
      )
    })
  }

  test('no stray .menu-item-* tone exists outside the spec', () => {
    const declared = new Set<string>([
      MENU_ITEM_CLASS,
      ...MENU_TONE_NAMES.map((tone) => menuToneClass(tone)),
      // The note variants are not tones a caller picks; they are how a `note`
      // node renders the tone it was given, so they live in the same namespace.
      ...MENU_TONE_NAMES.map((tone) => `${menuToneClass(tone)}-note`),
    ])
    const stray = new Set<string>()
    for (const sheet of STYLESHEETS) {
      for (const rule of rules(readFileSync(join(RENDERER, sheet), 'utf8'))) {
        for (const selector of rule.selectors) {
          for (const m of selector.matchAll(/\.(menu-item[a-zA-Z0-9_-]*)/g)) {
            if (!declared.has(m[1])) stray.add(`${sheet} → .${m[1]}`)
          }
        }
      }
    }
    assert.deepEqual(
      [...stray],
      [],
      `These .menu-item-* classes are styled but not declared in spec.ts:\n${[...stray].join('\n')}\n\n` +
        `Declare the tone in MENU_TONES, with an intent and all five states, or name it outside ` +
        `the menu-item- namespace.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 3 — a press has to feel like a press
 * ------------------------------------------------------------------ */

/** `:root`'s custom properties, resolved one level deep. */
function rootVars(): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(readFileSync(join(RENDERER, 'styles.css'), 'utf8'))
  assert.ok(block, 'styles.css must open with a :root block')
  const out = new Map<string, string>()
  for (const line of decomment(block[1]).split('\n')) {
    const decl = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (decl) out.set(decl[1], decl[2].trim())
  }
  return out
}

type Rgb = [number, number, number]

/** Resolve the small set of colour syntaxes `controls.css` actually uses. */
function resolveColor(value: string, vars: Map<string, string>): Rgb | null {
  const raw = value.trim()
  if (raw === 'transparent') return null

  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+?)\)$/.exec(raw)
  if (mix) {
    const a = resolveColor(mix[1], vars)
    const b = resolveColor(mix[3], vars)
    if (!a || !b) return null
    const w = Number(mix[2]) / 100
    return [0, 1, 2].map((i) => a[i] * w + b[i] * (1 - w)) as Rgb
  }

  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw)
  if (ref) {
    const v = vars.get(ref[1])
    return v === undefined ? null : resolveColor(v, vars)
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    const n = Number.parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  return null
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('hover and active are not the same gesture', () => {
  /*
   * This rule was already written in the stylesheet as prose — "press states
   * darken while hover lightens" — and the very first two variants written under
   * it broke it: `danger` and `caution` mixed *more* of their hue into the press,
   * which made the pressed state lighter than the hover. A screenshot caught it.
   *
   * A screenshot catching it is exactly the failure mode this whole layer exists
   * to remove: it means the rule held only as long as someone happened to look.
   * The invariant below is the part that can be stated mechanically — hover is
   * the brightest of the three, and a press moves back down from it. Whether the
   * press lands above or below rest is left free, because for a dark surface
   * tinted with red or amber it legitimately does not.
   */
  const css = readFileSync(join(UI, 'controls.css'), 'utf8')
  const vars = rootVars()

  function background(variant: ButtonVariant, state: ControlState): Rgb | null {
    const selector = stateSelector(variant, state).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rule = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(decomment(css))
    assert.ok(rule, `no rule for ${stateSelector(variant, state)}`)
    const decl = /(?:^|;)\s*background:\s*([^;]+)/.exec(rule[1])
    return decl ? resolveColor(decl[1], vars) : null
  }

  for (const variant of BUTTON_VARIANT_NAMES) {
    test(`${variant} lightens on hover and comes back down on press`, () => {
      const rest = background(variant, 'rest')
      const hover = background(variant, 'hover')
      const active = background(variant, 'active')

      assert.ok(hover, `${variant}:hover must set a background this test can resolve`)
      assert.ok(active, `${variant}:active must set a background this test can resolve`)

      assert.ok(
        luminance(hover) > luminance(active),
        `.btn-${variant}: the pressed state is lighter than the hovered one ` +
          `(${luminance(hover).toFixed(4)} vs ${luminance(active).toFixed(4)}).\n` +
          `A press that brightens reads as another hover — there is no acknowledgement in it. ` +
          `Mix :active from a darker surface (--bg-1) rather than from more of the variant's hue.`,
      )

      // `ghost` rests on transparent, so there is nothing to compare it against.
      if (rest) {
        assert.ok(
          luminance(hover) > luminance(rest),
          `.btn-${variant}:hover is not lighter than its resting state; nothing happens under the pointer.`,
        )
      }
    })
  }
})

/* ------------------------------------------------------------------
 * 4 — the className hatch stays a layout hatch
 * ------------------------------------------------------------------ */

describe('className on a Button is layout only', () => {
  test('no passed class repaints the control', () => {
    const owners = new Map<string, string[]>()
    for (const sheet of STYLESHEETS) {
      for (const rule of rules(readFileSync(join(RENDERER, sheet), 'utf8'))) {
        for (const selector of rule.selectors) {
          for (const m of selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
            owners.set(m[1], [...(owners.get(m[1]) ?? []), ...rule.properties])
          }
        }
      }
    }

    const offenders: string[] = []
    for (const { file, attrs } of buttonUsages()) {
      // Static `className="a b"` plus any string literal inside a dynamic one,
      // which covers `className={cond ? 'a' : 'b'}`. A className computed from a
      // non-literal is beyond static reach; noted rather than pretended away.
      const raw = /\bclassName=(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?:[a-zA-Z-]+=|$))/.exec(attrs)
      if (!raw) continue
      const names =
        raw[1] !== undefined
          ? raw[1].split(/\s+/)
          : [...(raw[2] ?? '').matchAll(/['"]([a-zA-Z0-9_ -]+)['"]/g)].flatMap((m) => m[1].split(/\s+/))

      for (const name of names.filter(Boolean)) {
        const bad = [...new Set(owners.get(name) ?? [])].filter((p) => !LAYOUT_ONLY_PROPERTIES.includes(p))
        if (bad.length > 0) offenders.push(`${file} → .${name} declares ${bad.join(', ')}`)
      }
    }

    assert.deepEqual(
      [...new Set(offenders)],
      [],
      `A Button's \`className\` may place the control, not paint it:\n${[...new Set(offenders)].join('\n')}\n\n` +
        `Split the class in two — keep the positioning, and move anything visual into a variant in ` +
        `spec.ts. If no existing variant fits, that is a real gap in the spec and the answer is to ` +
        `add one (see ${GUIDE}), not to reach around it.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 4 & 5 — semantic handles
 * ------------------------------------------------------------------ */

describe('action handles', () => {
  const withAction = buttonUsages()
    .map((u) => ({ ...u, action: attr(u.attrs, 'action'), exposure: attr(u.attrs, 'exposure') }))
    .filter((u) => u.action !== undefined || u.exposure !== undefined)

  test('ids follow the Command Bus domain.verb shape', () => {
    const bad = withAction
      .filter((u) => u.action !== undefined && !ACTION_ID_PATTERN.test(u.action))
      .map((u) => `${u.file} → action="${u.action}"`)
    assert.deepEqual(
      bad,
      [],
      `Action ids share a vocabulary with the Command Bus (PLAN §6), so they take its shape: ` +
        `lower-case \`domain.verb\`, e.g. "conn.book.forget".\n${bad.join('\n')}`,
    )
  })

  test('ids are unique across the renderer', () => {
    const seen = new Map<string, string[]>()
    for (const u of withAction) {
      if (u.action === undefined) continue
      seen.set(u.action, [...(seen.get(u.action) ?? []), u.file])
    }
    const dupes = [...seen].filter(([, files]) => files.length > 1).map(([id, files]) => `${id} → ${files.join(', ')}`)
    assert.deepEqual(
      dupes,
      [],
      `An action id is an address. Two controls sharing one means a test — or, later, an MCP ` +
        `caller — cannot say which it meant:\n${dupes.join('\n')}`,
    )
  })

  test('anything exposed to an agent has a name', () => {
    const nameless = withAction
      .filter((u) => u.exposure === 'agent-ok' && u.action === undefined)
      .map((u) => u.file)
    assert.deepEqual(
      nameless,
      [],
      `exposure="agent-ok" without an \`action\` id is unreachable by definition — there is no ` +
        `handle to address it by. Give it one, or drop the exposure:\n${nameless.join('\n')}`,
    )
  })
})

/* ------------------------------------------------------------------
 * 6 — the boundary that is a security property, not a style rule
 * ------------------------------------------------------------------ */

describe('an agent cannot be handed its own permission prompt', () => {
  test('every control in the permission prompt stays human-only', () => {
    const file = join(RENDERER, 'components', 'chat', 'PermissionPrompt.tsx')
    const attrs = openingTags(readFileSync(file, 'utf8'), 'Button')

    assert.ok(
      attrs.length > 0,
      `PermissionPrompt.tsx no longer renders any <Button>. Either it was reverted to bare ` +
        `<button> — which puts it outside every rule in this file — or the prompt moved and this ` +
        `test needs to follow it. Do not delete the test to make it pass.`,
    )

    const exposed = attrs.filter((a) => attr(a, 'exposure') === 'agent-ok')
    assert.equal(
      exposed.length,
      0,
      `A button in the permission prompt is marked agent-ok.\n\n` +
        `This prompt is where a person decides what an agent may do. An agent able to answer it ` +
        `approves its own requests, and the permission system stops meaning anything. Nothing reads ` +
        `data-peek-exposure yet — the boundary is written down now precisely so that whoever does ` +
        `build that reader inherits it rather than rediscovers it. See ${DOC} §2.6.`,
    )
  })
})

/* ------------------------------------------------------------------
 * 7 — migration only moves one way
 * ------------------------------------------------------------------ */

/**
 * Bare `<button>` elements that are deliberately **not** controls.
 *
 * The ledger below started from an assumption that turned out to be false:
 * that every `<button>` in the renderer wants to be a `<Button>`. Migrating 80
 * of them proved otherwise. What is left is a different kind of element — a menu
 * item, a disclosure header, a tab — that needs button *semantics* (focusable,
 * activated by Enter and Space, announced as pressable) and nothing at all from
 * the control layer. Forcing one through `<Button>` would mean overriding every
 * declaration `.btn` makes, which is not migration, it is a fight.
 *
 * They are listed rather than pattern-matched because "this is not a control" is
 * a judgement, and a judgement that nobody wrote down is indistinguishable from
 * an oversight. Same demand as the opacity census and the hit-target exemptions:
 * **being outside the rule has to be a sentence somebody wrote.**
 *
 * `count` is the part that keeps this honest at file granularity. Without it,
 * a file admitted here for its two menu items would silently accept a third
 * element that *is* a control.
 */
const NOT_CONTROLS: readonly { where: string; count: number; reason: string }[] = [
  {
    where: 'components/chat/AttachmentBar.tsx',
    count: 1,
    reason:
      'A menu item, in the attach dropdown. The `<Menu>` primitive that took the context menu\'s two ' +
      'items anchors to a *point*, and this one anchors to a button, so adopting it would mean ' +
      'inventing element anchoring for a single caller — deferred on purpose in the menu design record.',
  },
  {
    where: 'components/chat/ToolCallCard.tsx',
    count: 1,
    reason:
      'A disclosure header: it carries `aria-expanded` and wraps a status mark, a name and a summary ' +
      'across the full width of the card. It is a region you can open, not an action you can take.',
  },
  {
    where: 'components/chat/MessageItem.tsx',
    count: 1,
    reason: 'The thinking block\'s disclosure header. Same kind as ToolCallCard\'s.',
  },
  {
    where: 'components/settings/SettingsDialog.tsx',
    count: 1,
    reason:
      'A tab — `role="tab"` inside a `role="tablist"`, so a screen reader announces "2 of 4". ' +
      'PanelTabs reached the same conclusion from the other direction and uses a `div role="tab"`.',
  },
]

/**
 * Files still to migrate. This list may only get shorter.
 *
 * It is down to one, and that one is blocked on something outside the change:
 * `TreeView.tsx` has uncommitted work in it from another thread, and migrating a
 * file someone else is editing trades a tidy ledger for a merge conflict.
 *
 * The honest limit, unchanged: this cannot stop someone appending a new file. A
 * newly created file is indistinguishable from a half-migrated one to a static
 * check. That half is enforced by people; saying so beats a test that pretends
 * to cover it.
 */
const MIGRATION_LEDGER: readonly string[] = ['components/views/TreeView.tsx']

/** Not on either list — they are the primitives, and must render the real element. */
const PRIMITIVES: readonly string[] = ['ui/Button.tsx', 'ui/Segmented.tsx', 'ui/Menu.tsx']

describe('bare <button> is confined to what is written down', () => {
  const exempt = new Set([...PRIMITIVES, ...MIGRATION_LEDGER, ...NOT_CONTROLS.map((n) => n.where)])

  test('no file outside those lists renders one', () => {
    const offenders: string[] = []
    for (const path of tsxFiles()) {
      const rel = relative(RENDERER, path)
      if (exempt.has(rel)) continue
      if (openingTags(readFileSync(path, 'utf8'), 'button').length > 0) offenders.push(rel)
    }
    assert.deepEqual(
      offenders,
      [],
      `These files render a raw <button>:\n${offenders.join('\n')}\n\n` +
        `Use <Button> from renderer/ui/Button. It is the collection point — the reason "destructive" ` +
        `ended up with three separate implementations, two of them identical, is that there was ` +
        `nowhere to look and nowhere to add. See ${GUIDE}.`,
    )
  })

  test('a file that is not a control has exactly the elements it declared', () => {
    // The tightening that makes a file-level exemption safe: an entry admitted
    // for its two menu items must not quietly grow a third element that is a
    // control.
    const wrong: string[] = []
    for (const entry of NOT_CONTROLS) {
      const found = openingTags(readFileSync(join(RENDERER, entry.where), 'utf8'), 'button').length
      if (found !== entry.count) wrong.push(`${entry.where}: declared ${entry.count}, found ${found}`)
    }
    assert.deepEqual(
      wrong,
      [],
      `A file listed as not-a-control changed shape:\n${wrong.join('\n')}\n\n` +
        `If the new element is a menu item or a disclosure like its neighbours, raise the count and ` +
        `say so in the reason. If it is a control, it belongs in <Button>.`,
    )
  })

  test('every not-a-control entry says why', () => {
    for (const entry of NOT_CONTROLS) {
      assert.ok(
        entry.reason.trim().length > 60,
        `${entry.where} is exempt without a reason worth reading. "This is not a control" is a ` +
          `judgement, and a judgement nobody wrote down cannot be told apart from an oversight.`,
      )
    }
  })

  test('the ledger has no stale entries', () => {
    const stale = MIGRATION_LEDGER.filter((rel) => {
      let src: string
      try {
        src = readFileSync(join(RENDERER, rel), 'utf8')
      } catch {
        return true
      }
      return openingTags(src, 'button').length === 0
    })
    assert.deepEqual(
      stale,
      [],
      `These files are on the migration ledger but no longer need to be — they are done, or gone:\n` +
        `${stale.join('\n')}\n\nDelete their lines from MIGRATION_LEDGER. The list only ever ` +
        `shrinks, and leaving a finished entry on it re-opens the hole for the next edit to that file.`,
    )
  })
})
