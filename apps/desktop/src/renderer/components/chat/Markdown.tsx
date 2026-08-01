import { Fragment, memo, useCallback, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useT } from '../../i18n'
import { highlight, normalizeLang } from './highlight'
import { parseMarkdown, type MdAlign, type MdBlock, type MdInline } from './mdParser'

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
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i))}</div>
})

function renderBlock(block: MdBlock, key: number): ReactElement {
  switch (block.type) {
    case 'paragraph':
      return <p key={key}>{renderInline(block.inline)}</p>

    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      // Heading levels inside a message are visual weight, not document
      // structure — the panel already sits under the app's real headings, so
      // they render as a styled div rather than as h1…h6 that would corrupt the
      // page outline for a screen reader.
      return (
        <div key={key} className={`md-h md-h${level}`}>
          {renderInline(block.inline)}
        </div>
      )
    }

    case 'code':
      return <CodeBlock key={key} lang={block.lang} text={block.text} closed={block.closed} />

    case 'hr':
      return <div key={key} className="md-hr" />

    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {block.blocks.map((b, i) => renderBlock(b, i))}
        </blockquote>
      )

    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className={item.checked === null ? undefined : 'md-task'}>
          {item.checked === null ? null : (
            <span className={`md-check${item.checked ? ' on' : ''}`} aria-hidden="true">
              {item.checked ? '✔' : ''}
            </span>
          )}
          {item.blocks.map((b, j) => renderBlock(b, j))}
        </li>
      ))
      return block.ordered ? (
        <ol key={key} className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      )
    }

    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} style={alignOf(block.align[i])}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} style={alignOf(block.align[c])}>
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
          <code key={i} className="md-code">
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
          <span key={i} className="md-link" title={node.href}>
            {renderInline(node.children)}
          </span>
        )
    }
  })
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
    <div className={`md-pre${closed ? '' : ' streaming'}`}>
      <div className="md-pre-bar">
        <span className="md-pre-lang">{lang || normalized}</span>
        <button type="button" className="ghost md-copy" onClick={copy}>
          {copied ? t('chat.code.copied') : t('chat.code.copy')}
        </button>
      </div>
      <pre>
        <code>
          {tokens.map((tok, i) =>
            tok.kind === 'plain' ? (
              <Fragment key={i}>{tok.text}</Fragment>
            ) : (
              <span key={i} className={`tok-${tok.kind}`}>
                {tok.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  )
}
