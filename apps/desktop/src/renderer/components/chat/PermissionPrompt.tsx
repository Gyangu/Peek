import { useMemo } from 'react'
import type { ReactElement } from 'react'
import type { PendingPermission, PermissionOption, ViewId } from '@peek/core'
import { respondPermission } from './chatCommands'
import { useChatT, type ChatTFunction } from './i18n'
import { parseToolTitle } from './toolCalls'

/**
 * The moment the agent asks a human.
 *
 * This is the load-bearing part of letting a model drive the window. peek's own
 * MCP tools can open views, run queries and rearrange the layout, so the honest
 * question is not "may I call a tool" but **"may I change what you are looking
 * at"** — and the prompt says so, in those words, when the tool is one of peek's
 * mutating ones.
 *
 * Three rules it keeps:
 *
 *  - the tool's real identifier is always shown next to the friendly sentence.
 *    A permission dialog that only paraphrases is a dialog you cannot audit;
 *  - the arguments are shown. `inputPreview` is truncated by main before it ever
 *    reaches Workspace, so this renders a preview and never claims to be the
 *    whole input;
 *  - the button labels are localized by `kind`, but the value sent back is the
 *    agent's own `optionId`. Those two strings differ (`allow` vs `allow_once`),
 *    and the agent only accepts the id.
 *
 * The panel is modal in attention, not in the DOM: it sits above the composer
 * rather than over the window, because the user frequently needs to read the
 * transcript — the tool call that led here — before deciding.
 */
export function PermissionPrompt({
  viewId,
  permission,
}: {
  viewId: ViewId
  permission: PendingPermission
}): ReactElement {
  const t = useChatT()
  const parsed = useMemo(() => parseToolTitle(permission.toolName), [permission.toolName])

  const title = parsed.isPeek
    ? parsed.mutatesWorkspace
      ? t('chat.permission.titlePeek')
      : t('chat.permission.titlePeekRead')
    : t('chat.permission.title')

  return (
    <div className={`chat-permission${parsed.mutatesWorkspace ? ' mutating' : ''}`} role="alertdialog">
      <div className="chat-permission-title">{title}</div>

      <div className="chat-permission-row">
        <span className="chat-permission-key">{t('chat.permission.tool')}</span>
        <span className="mono chat-permission-val">{permission.toolName}</span>
      </div>

      {permission.inputPreview === '' ? null : (
        <div className="chat-permission-row">
          <span className="chat-permission-key">{t('chat.permission.arguments')}</span>
          <span className="mono chat-permission-val">{permission.inputPreview}</span>
        </div>
      )}

      <div className="chat-permission-note">{t('chat.permission.waiting')}</div>

      <div className="chat-permission-actions">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={buttonClass(option)}
            onClick={() => {
              void respondPermission(viewId, option.optionId, permission.requestId)
            }}
            // The agent's own wording, kept as a tooltip: the localized label is
            // for reading, this is what the agent thinks it offered.
            title={option.name}
          >
            {optionLabel(option, t)}
          </button>
        ))}
      </div>
    </div>
  )
}

function optionLabel(option: PermissionOption, t: ChatTFunction): string {
  switch (option.kind) {
    case 'allow_once':
      return t('chat.permission.kind.allow_once')
    case 'allow_always':
      return t('chat.permission.kind.allow_always')
    case 'reject_once':
      return t('chat.permission.kind.reject_once')
    case 'reject_always':
      return t('chat.permission.kind.reject_always')
    default:
      // An option kind this build does not know still has to be offerable, and
      // the agent's English name is better than nothing at all.
      return option.name
  }
}

function buttonClass(option: PermissionOption): string {
  if (option.kind === 'allow_once') return 'primary'
  if (option.kind === 'allow_always') return 'chat-perm-always'
  return 'chat-perm-reject'
}
