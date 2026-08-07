import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { tStatic, useT } from '../../i18n'
import { notify } from '../../state/notifyStore'
import { highlight, normalizeLang, type TokenKind } from './highlight'
import { parseMarkdown, type MdAlign, type MdBlock, type MdInline } from './mdParser'
import { Button } from '../../ui/Button'
import { Menu } from '../../ui/Menu'
import { useContextMenu } from '../../ui/useContextMenu'

/**
 * Renders agent Markdown.
 *
 * ## Re-parsed from the accumulated text, never per chunk
 *
 * `agent_message_chunk` splits mid-word and mid-syntax — one chunk can be a
 * single backtick. Parsing chunks and concatenating the results would produce
 * garbage, so the block holds the whole accumulated string and this component
 * re-parses it. That is only affordable because the parse is memoized on the
 * text and the component is memoized on its props: while a message streams,
 * exactly one `Markdown` in the transcript re-parses, and it re-parses a
 * message-sized string, not a transcript-sized one.
 *
 * ## Links do not navigate
 *
 * A link in agent output is untrusted content. The renderer has no
 * external-browser channel, so an `<a href>` here would either do nothing or —
 * worse — navigate the window and replace peek's own UI with a remote page. The
 * URL is shown and can be read and copied; it is not clickable. If peek ever
 * grows a vetted "open externally" channel this is the single place to change.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactElement {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  /*
   * The first and last block give up their outer margin, so a message's own
   * padding is the only thing between its text and its edge.
   *
   * That is a fact about a child's *position among its siblings*, which is why
   * it was two rules in chat.css until §11.2 of the migration record. The
   * first-child and last-child variants alone would be wrong — they match a
   * first child of any parent, and `renderBlock` recurses into blockquotes and
   * list items where the first paragraph keeps its margin. Stacking them under
   * the direct-child variant restores the combinator, so the pair compiles to
   * the same two selectors, matched from this element and no other.
   *
   * Verified in the build: the emitted selectors are the container class, a
   * child combinator and the positional pseudo, at the same specificity the
   * hand-written rules had. They sit in the utilities layer now rather than
   * unlayered — which holds because every margin inside a message is itself a
   * utility of lower specificity, and nothing unlayered sets a margin on a
   * Markdown block.
   */
  return (
    <div className="*:first:mt-0 *:last:mb-0 break-words">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  )
})

/**
 * The heading ladder, which is **not** the window's type scale.
 *
 * The chrome's rungs size peek itself. These size prose the agent wrote, and
 * its top rung (15px) is a size the chrome ladder deliberately does not have —
 * adding it there would grow a scale whose whole value is being small, to serve
 * text that is not chrome. So `md-h1` stays a `font-size` rule in `styles.css`,
 * above the floor and visible to `type-scale.test.ts`, and the rest lands on
 * rungs that exist.
 *
 * **h2 and h3 are the same size now, and that is a loss, not a typo.** They were
 * 14px and 13px. Tailwind's rungs step 12 → 14 → 18 with nothing between, so
 * once the window went to default values (§30.3) 13px had no home: the next rung
 * up is 18px, which would put h3 *four pixels above* h2 — and that inversion
 * actually shipped for a round, unseen, because nothing in this repo checks that
 * a heading ladder descends and the render probe does not mount Markdown.
 * `text-title` for both is the honest reading of a scale that no longer has a rung
 * there; `font-semibold` on the wrapper and the margins still separate them.
 *
 * The rung above is named here by its size and not by its class, on purpose:
 * Tailwind's scanner reads comments, so writing the class would compile it into
 * the bundle and `type-scale.test.ts` would reject this file — which it did,
 * for the first draft of this very paragraph.
 *
 * Each rung states its own colour rather than overriding a shared one. A class
 * list has no cascade: `text-fg text-fg-dim` on one element is decided by
 * Tailwind's emission order, not by the order written here.
 */
const HEADING: Record<number, string> = {
  1: 'md-h1 text-fg',
  2: 'text-title leading-prose text-fg',
  3: 'text-title text-fg',
  4: 'text-body text-fg-dim',
  5: 'text-body text-fg-dim',
  6: 'text-body text-fg-dim',
}

function renderBlock(block: MdBlock, key: number): ReactElement {
  switch (block.type) {
    case 'paragraph':
      // `whitespace-pre-wrap`: a soft line break inside an agent's paragraph is
      // one the agent meant.
      return (
        <p key={key} className="my-tight whitespace-pre-wrap">
          {renderInline(block.inline)}
        </p>
      )

    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      // Heading levels inside a message are visual weight, not document
      // structure — the panel already sits under the app's real headings, so
      // they render as a styled div rather than as h1…h6 that would corrupt the
      // page outline for a screen reader.
      return (
        <div key={key} className={`mt-snug mb-tight font-semibold ${HEADING[level]}`}>
          {renderInline(block.inline)}
        </div>
      )
    }

    case 'code':
      return <CodeBlock key={key} lang={block.lang} text={block.text} closed={block.closed} />

    case 'hr':
      return <div key={key} className="h-px my-snug bg-border" />

    case 'quote':
      return (
        <blockquote key={key} className="my-tight py-inset pl-snug border-l-2 border-l-border-strong text-fg-dim">
          {block.blocks.map((b, i) => renderBlock(b, i))}
        </blockquote>
      )

    case 'list': {
      const items = block.items.map((item, i) => (
        // A task item pulls back out of the list's indent and drops its marker:
        // the checkbox is the marker.
        <li key={i} className={`my-inset${item.checked === null ? '' : ' list-none -ml-loose'}`}>
          {item.checked === null ? null : (
            // `relative top-px` is `vertical-align: -1px` — the optical nudge
            // that seats an 11px box on the text baseline. There is no
            // utility for a length there, and the arbitrary-value spelling is
            // banned; a 1px offset says the same thing in the vocabulary that
            // exists.
            <span
              className={`inline-block relative top-px w-2.75 h-2.75 mr-tight rounded-mark border text-mark leading-mark text-center ${
                item.checked ? 'border-ok text-ok' : 'border-border-strong'
              }`}
              aria-hidden="true"
            >
              {item.checked ? '✔' : ''}
            </span>
          )}
          {item.blocks.map((b, j) => renderBlock(b, j))}
        </li>
      ))
      return block.ordered ? (
        <ol key={key} className={LIST} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className={LIST}>
          {items}
        </ul>
      )
    }

    case 'table':
      return (
        <div key={key} className="my-tight overflow-x-auto rounded-control border border-border">
          {/* The rules run on the rows rather than on the cells, which
              `border-collapse` honours and which is what lets the last row drop
              its own with `last:` instead of a selector reaching down into it. */}
          <table className="w-full border-collapse font-mono text-micro">
            <thead>
              <tr className="border-b border-border">
                {block.head.map((cell, i) => (
                  <th key={i} className={`${CELL} bg-bg-2 text-left font-semibold text-fg-dim`} style={alignOf(block.align[i])}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} className={CELL} style={alignOf(block.align[c])}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

const LIST = 'my-tight pl-loose'
const CELL = 'px-snug py-inset whitespace-nowrap'

function alignOf(align: MdAlign | undefined): { textAlign?: 'left' | 'center' | 'right' } {
  return align === 'center' || align === 'right' || align === 'left' ? { textAlign: align } : {}
}

function renderInline(nodes: MdInline[]): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>
      case 'code':
        return (
          <code key={i} className="px-inset rounded-control bg-bg-2 border border-border font-mono text-micro">
            {node.text}
          </code>
        )
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>
      case 'del':
        return <del key={i}>{renderInline(node.children)}</del>
      case 'link':
        return (
          // Deliberately not an anchor — see the note at the top of the file.
          // It is a *copy* control, though, which is the part that used to be
          // missing: it was styled like a link, carried `cursor: help`, and did
          // nothing whatsoever when clicked. Promising navigation and then
          // silently refusing is worse than either navigating or looking inert.
          // Not an anchor, and it used to *look* exactly like one — accent,
          // underlined — while doing nothing at all on click, with `cursor: help`
          // as the only hint. That is a deceptive affordance: the pointer
          // promised something the element could not do. It copies the URL now,
          // and `cursor-copy` says so before the click. The dotted underline is
          // what keeps it from claiming to be a link.
          <span
            key={i}
            className="text-accent underline decoration-dotted hover:decoration-solid cursor-copy"
            role="button"
            tabIndex={0}
            title={node.href}
            onClick={() => {
              copyLink(node.href)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              copyLink(node.href)
            }}
          >
            {renderInline(node.children)}
          </span>
        )
    }
  })
}

/**
 * The clipboard, as what a link in agent output actually does.
 *
 * Not navigation: the renderer has no vetted external-browser channel, agent
 * output is untrusted, and giving one to a string the model produced is a
 * different decision from this one. Copying keeps the URL useful without opening
 * that door.
 */
function copyLink(href: string): void {
  void navigator.clipboard.writeText(href).then(
    () => {
      notify('info', tStatic('chat.md.linkCopied'))
    },
    () => {
      notify('warn', tStatic('chat.md.linkCopyFailed'))
    },
  )
}

/* ------------------------------------------------------------------ */
/* Code                                                                */
/* ------------------------------------------------------------------ */

/** A fenced block: language label, copy button, and hand-rolled colouring. */
function CodeBlock({
  lang,
  text,
  closed,
}: {
  lang: string
  text: string
  closed: boolean
}): ReactElement {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const menu = useContextMenu<null>()
  const normalized = normalizeLang(lang)
  const tokens = useMemo(() => highlight(text, normalized), [text, normalized])

  const copy = useCallback(() => {
    // `navigator.clipboard` is unavailable in a non-secure context; failing to
    // copy must not take the transcript down with it.
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1200)
      })
      .catch(() => {
        setCopied(false)
      })
  }, [text])

  return (
    // A dashed border while the closing fence has not arrived: the block is
    // still being written.
    <div
      className={`my-snug rounded-control overflow-hidden bg-bg-1 border border-border${closed ? '' : ' border-dashed'}`}
      onContextMenu={menu.open(null)}
    >
      {/* The bar's Copy button is the discoverable path and stays. This is the
          one for someone who is already pointing at the code. */}
      {menu.state ? (
        <Menu
          label={t('menu.code.label')}
          at={menu.state.at}
          nodes={[{ kind: 'item', id: 'code.copy', label: t('menu.code.copy'), onSelect: copy }]}
          onClose={menu.close}
        />
      ) : null}
      <div className="flex items-center justify-between py-inset pl-snug pr-tight bg-bg-2 border-b border-border">
        <span className="text-micro lowercase text-fg-faint">{lang || normalized}</span>
        {/* `sm` carries the height and padding this used to spell out as a class
            of its own; what is left is the one thing that is layout — no margin
            in a strip whose own padding is 1px. */}
        <Button variant="ghost" size="sm" className="m-0" onClick={copy}>
          {copied ? t('chat.code.copied') : t('chat.code.copy')}
        </Button>
      </div>
      <pre className="m-0 px-snug py-tight overflow-x-auto font-mono text-micro leading-prose">
        <code>
          {tokens.map((tok, i) =>
            tok.kind === 'plain' ? (
              <Fragment key={i}>{tok.text}</Fragment>
            ) : (
              <span key={i} className={TOKEN_CLASS[tok.kind]}>
                {tok.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}

/**
 * Code colouring, one class per token kind.
 *
 * A lookup rather than the `tok-${kind}` the class name used to be built by:
 * Tailwind only ever sees the strings that are literally in the source, so a
 * class name assembled at runtime generates no CSS at all. Its natural home is
 * `highlight.ts`, next to `TokenKind` — it is here because that file was outside
 * this change's reach, and both callers already import from this one.
 *
 * Comments and punctuation take text weights rather than hues: "this is an
 * aside" and "this is grammar" are facts the foreground ladder already states,
 * and spending a colour on them would leave four hues doing five jobs.
 */
export const TOKEN_CLASS: Record<Exclude<TokenKind, 'plain'>, string> = {
  keyword: 'text-code-keyword',
  type: 'text-code-type',
  string: 'text-code-string',
  number: 'text-code-number',
  comment: 'text-fg-faint italic',
  punct: 'text-fg-dim',
}
