import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { McpStatus } from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { notify } from '../../state/notifyStore'
import { Button } from '../../ui/Button'

/**
 * The MCP endpoint, as something the user can see and change.
 *
 * Before this panel, the endpoint was three facts a person could only get at by
 * reading a file: `cat ~/.peek/mcp.json`, find the `hint` field, copy it out of
 * JSON. The port was a constant, and rotating the token meant deleting the file
 * and restarting. All three are the same job — *register this window with an AI
 * client, and be able to un-register it* — so they belong on one surface.
 *
 * Three decisions worth keeping:
 *
 * - **The token is masked until asked for.** It is a bearer credential, and this
 *   window gets screen-shared and screenshotted into bug reports. The copy
 *   button does not require revealing it, so the common path never puts it on
 *   screen at all.
 * - **Rotation states its consequence before it happens, not after.** Every
 *   client that has been registered stops working the moment the token changes;
 *   that is the entire point of rotating, and it is also the thing a user will
 *   not have thought about.
 * - **A restart is polled, not awaited.** `mcp.configure` answers as soon as the
 *   choice is durable — see the note on `McpController` — so the panel watches
 *   `restarting` rather than blocking on a command that would be holding the
 *   event loop the endpoint needs to rebind.
 */
export function McpSection(): ReactElement {
  const t = useT()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [reveal, setReveal] = useState(false)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** Set once the user edits the port box, so a poll cannot overwrite what they are typing. */
  const portTouched = useRef(false)

  const refresh = useCallback(async (): Promise<McpStatus | null> => {
    const next = await dispatch('mcp.read', {})
    if (next) {
      setStatus(next)
      if (!portTouched.current) setPort(String(next.preferredPort))
    }
    return next
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // While a rebind is in flight the panel is showing a port that is about to be
  // wrong. Half a second is slow enough to be free and fast enough that the user
  // does not reach for the copy button before the URL settles.
  useEffect(() => {
    if (status?.restarting !== true) return
    const timer = setInterval(() => {
      void refresh()
    }, 500)
    return () => {
      clearInterval(timer)
    }
  }, [status?.restarting, refresh])

  const copy = (text: string, message: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setNotice(message)
      },
      () => {
        // Clipboard access can be refused; saying so beats a button that looks
        // like it worked.
        notify('warn', t('mcp.copyFailed'))
      },
    )
  }

  const applyPort = (): void => {
    const parsed = Number(port)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      setNotice(t('mcp.portInvalid'))
      return
    }
    if (status && parsed === status.preferredPort && status.listening) {
      setNotice(t('mcp.portUnchanged'))
      return
    }
    setBusy(true)
    void dispatch('mcp.configure', { port: parsed })
      .then((res) => {
        if (res) {
          setStatus(res)
          portTouched.current = false
          setNotice(res.reregisterRequired ? t('mcp.reregisterRequired') : t('mcp.portApplied'))
        }
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const rotate = (): void => {
    setBusy(true)
    setReveal(false)
    void dispatch('mcp.configure', { rotateToken: true })
      .then((res) => {
        if (res) {
          setStatus(res)
          setNotice(t('mcp.tokenRotated'))
        }
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const token = status?.token ?? ''
  const masked = token === '' ? '' : `${token.slice(0, 4)}${'•'.repeat(24)}`

  return (
    <>
      <div className="settings-intro">{t('mcp.intro')}</div>

      <div className="form-row">
        <label>{t('mcp.state')}</label>
        <span style={{ color: status?.listening === true ? 'var(--fg)' : 'var(--err)' }}>
          {status === null
            ? t('mcp.stateUnknown')
            : status.restarting
              ? t('mcp.stateRestarting')
              : status.listening
                ? t('mcp.stateListening')
                : t('mcp.stateDown')}
        </span>
      </div>

      {/* The endpoint is an identifier; it is never translated. */}
      <div className="form-row">
        <label htmlFor="peek-mcp-url">{t('mcp.endpoint')}</label>
        <input id="peek-mcp-url" className="mono" readOnly value={status?.url ?? ''} spellCheck={false} />
      </div>

      <div className="form-row">
        <label htmlFor="peek-mcp-token">{t('mcp.token')}</label>
        <input
          id="peek-mcp-token"
          className="mono"
          readOnly
          value={reveal ? token : masked}
          spellCheck={false}
          /* A masked bearer token is still a bearer token: never offer it to a password manager. */
          autoComplete="off"
        />
      </div>
      <div className="conn-actions">
        <Button
          variant="ghost"
          disabled={token === ''}
          onClick={() => {
            setReveal((value) => !value)
          }}
        >
          {reveal ? t('mcp.hide') : t('mcp.reveal')}
        </Button>
        <Button
          variant="ghost"
          disabled={token === ''}
          onClick={() => {
            copy(token, t('mcp.tokenCopied'))
          }}
        >
          {t('mcp.copyToken')}
        </Button>
        <Button
          variant="primary"
          disabled={status?.hint === undefined || status.hint === ''}
          onClick={() => {
            copy(status?.hint ?? '', t('mcp.commandCopied'))
          }}
        >
          {t('mcp.copyCommand')}
        </Button>
      </div>
      <div className="form-hint mono" style={{ wordBreak: 'break-all' }}>
        {status?.hint === '' ? t('mcp.noCommandYet') : status?.hint}
      </div>

      <div className="form-row">
        <label htmlFor="peek-mcp-port">{t('mcp.port')}</label>
        <input
          id="peek-mcp-port"
          type="number"
          value={port}
          onChange={(e) => {
            portTouched.current = true
            setPort(e.target.value)
            setNotice(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyPort()
          }}
        />
      </div>
      {status !== null && status.listening && status.port !== status.preferredPort ? (
        // The fallback already warned once as a toast; a toast is gone by the
        // time someone opens this panel to find out where the endpoint went.
        <div className="form-hint" style={{ color: 'var(--warn, var(--err))' }}>
          {t('mcp.portFallback', { preferred: String(status.preferredPort), actual: String(status.port) })}
        </div>
      ) : null}
      {status?.error ? <div className="form-hint" style={{ color: 'var(--err)' }}>{status.error.message}</div> : null}

      <div className="conn-actions">
        <Button disabled={busy} onClick={applyPort}>
          {t('mcp.applyPort')}
        </Button>
        <Button disabled={busy} onClick={rotate}>
          {t('mcp.rotateToken')}
        </Button>
      </div>
      <div className="form-hint">{t('mcp.rotateWarning')}</div>

      {notice ? <div className="form-hint">{notice}</div> : null}
    </>
  )
}
