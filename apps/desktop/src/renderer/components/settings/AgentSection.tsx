import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  AGENT_DEFAULT_PERMISSION_MODES,
  AGENT_ENDPOINT_APIS,
  type AgentBackend,
  type AgentDefaultPermissionMode,
  type AgentSettingsReadResult,
} from '@peek/core'
import { useT } from '../../i18n'
import { dispatch } from '../../state/dispatch'
import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'

/**
 * Which agent answers in the chat panel.
 *
 * Two shapes of the same choice, and the split is what the whole section is
 * about. **Ship with an agent** runs Claude Code or Codex as a child process and
 * reuses the login the user already has — peek never sees a credential.
 * **Bring an endpoint** runs peek's own loop against a model the user configured,
 * which is the path for a self-hosted server or a company gateway, and is the one
 * place in peek that takes an API key for something other than a database.
 *
 * Three things this form states out loud rather than leaving to be discovered:
 *
 *  - **A change applies to the next launch.** An agent is a live child process
 *    with open sessions; swapping it under a running conversation would hand a
 *    transcript to something that cannot read it.
 *  - **Existing conversations keep their agent.** The two backends store history
 *    in different places and neither can read the other's, so a conversation is
 *    fixed to the agent it was created on. The sessions list says which.
 *  - **`unverified` means unverified.** peek runs a probe against Claude Code that
 *    checks its sandbox actually took. There is no such probe for Codex yet, and
 *    saying so is more useful than a badge that implies one exists.
 *
 * The API key is write-only from here: it goes to main, is sealed by the OS
 * keychain, and never comes back. `apiKeySet` is the only thing the form learns
 * about it.
 */
export function AgentSection(): ReactElement {
  const t = useT()
  const [agent, setAgent] = useState<AgentSettingsReadResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void dispatch('settings.read', {}).then((res) => {
      if (res) setAgent(res.agent)
    })
  }, [])

  /** Persist a patch and adopt whatever main says the settings now are. */
  const write = (patch: Parameters<typeof buildAgentPatch>[0]): void => {
    setBusy(true)
    setNotice(null)
    void dispatch('settings.write', { agent: buildAgentPatch(patch) })
      .then((res) => {
        if (res) {
          setAgent(res.agent)
          setNotice(t('settings.agent.saved'))
        }
      })
      .finally(() => {
        setBusy(false)
      })
  }

  if (!agent) return <div className="settings-intro">{t('settings.agent.intro')}</div>

  return (
    <>
      <div className="settings-intro">{t('settings.agent.intro')}</div>

      <div className="form-row">
        <span className="form-label">{t('settings.agent.backend')}</span>
        <Segmented
          label={t('settings.agent.backend')}
          value={agent.backend}
          options={[
            { value: 'acp' satisfies AgentBackend, label: t('settings.agent.backend.acp') },
            { value: 'endpoint' satisfies AgentBackend, label: t('settings.agent.backend.endpoint') },
          ]}
          onChange={(backend) => {
            write({ backend })
          }}
        />
      </div>
      <div className="form-hint">{t('settings.agent.restartHint')}</div>

      <div className="form-row">
        <span className="form-label">{t('settings.agent.permissionMode')}</span>
        {/* The two ⚠ modes in the panel's own dropdown are deliberately absent
            here. Reaching for one on a conversation you are looking at is a
            decision; leaving one in a settings file is something you forget. */}
        <Segmented
          label={t('settings.agent.permissionMode')}
          value={agent.permissionMode}
          options={AGENT_DEFAULT_PERMISSION_MODES.map((mode) => ({
            value: mode,
            label: t(`settings.agent.mode.${mode}`),
          }))}
          onChange={(permissionMode) => {
            write({ permissionMode })
          }}
        />
      </div>
      <div className="form-hint">{t(`settings.agent.modeHint.${agent.permissionMode}`)}</div>

      {agent.backend === 'acp' ? (
        <AcpForm agent={agent} busy={busy} onWrite={write} />
      ) : (
        <EndpointForm agent={agent} busy={busy} onWrite={write} />
      )}

      {notice === null ? null : <div className="form-hint">{notice}</div>}
    </>
  )
}

/* ================================================================== */
/* The bundled agents                                                  */
/* ================================================================== */

interface FormProps {
  agent: AgentSettingsReadResult
  busy: boolean
  onWrite: (patch: Parameters<typeof buildAgentPatch>[0]) => void
}

function AcpForm({ agent, busy, onWrite }: FormProps): ReactElement {
  const t = useT()
  const selected = agent.profiles.find((p) => p.id === agent.acpProfile)
  const [path, setPath] = useState(agent.acpExecutablePath ?? '')

  return (
    <>
      <div className="form-row">
        <span className="form-label">{t('settings.agent.which')}</span>
        <Segmented
          label={t('settings.agent.which')}
          value={agent.acpProfile}
          options={agent.profiles.map((profile) => ({
            value: profile.id,
            // An agent whose package this build does not carry is shown and
            // disabled rather than hidden: "Codex is not installed" is an answer,
            // an absent row is a mystery.
            label: profile.available ? profile.displayName : `${profile.displayName} — ${t('settings.agent.missing')}`,
            disabled: !profile.available,
          }))}
          onChange={(acpProfile) => {
            onWrite({ acpProfile })
          }}
        />
      </div>

      {selected?.sandbox === 'unverified' ? (
        <div className="form-hint form-warn">{t('settings.agent.unverified', { agent: selected.displayName })}</div>
      ) : (
        <div className="form-hint">{t('settings.agent.enforced')}</div>
      )}

      <div className="form-hint">{t('settings.agent.loginHint')}</div>

      <div className="form-row">
        <label htmlFor="peek-agent-exe">{t('settings.agent.executable')}</label>
        <input
          id="peek-agent-exe"
          className="mono"
          value={path}
          spellCheck={false}
          placeholder={t('settings.agent.executablePlaceholder')}
          onChange={(e) => {
            setPath(e.target.value)
          }}
        />
      </div>
      <div className="form-row form-actions">
        <Button
          disabled={busy || path === (agent.acpExecutablePath ?? '')}
          onClick={() => {
            onWrite({ acpExecutablePath: path })
          }}
        >
          {t('settings.agent.save')}
        </Button>
      </div>
      <div className="form-hint">{t('settings.agent.executableHint')}</div>
    </>
  )
}

/* ================================================================== */
/* A user's own endpoint                                               */
/* ================================================================== */

function EndpointForm({ agent, busy, onWrite }: FormProps): ReactElement {
  const t = useT()
  const existing = agent.endpoint
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const [api, setApi] = useState(existing?.api ?? 'openai-completions')
  // Never seeded from stored state: there is nothing to seed it *from*. The key
  // is sealed in the keychain and main does not send it back, which is the point.
  const [apiKey, setApiKey] = useState('')

  const complete = baseUrl.trim().length > 0 && model.trim().length > 0

  return (
    <>
      <div className="form-row">
        <label htmlFor="peek-agent-url">{t('settings.agent.baseUrl')}</label>
        <input
          id="peek-agent-url"
          className="mono"
          value={baseUrl}
          spellCheck={false}
          placeholder="http://localhost:11434/v1"
          onChange={(e) => {
            setBaseUrl(e.target.value)
          }}
        />
      </div>

      <div className="form-row">
        <label htmlFor="peek-agent-model">{t('settings.agent.model')}</label>
        <input
          id="peek-agent-model"
          className="mono"
          value={model}
          spellCheck={false}
          placeholder="qwen3-coder"
          onChange={(e) => {
            setModel(e.target.value)
          }}
        />
      </div>
      <div className="form-hint">{t('settings.agent.modelHint')}</div>

      <div className="form-row">
        <span className="form-label">{t('settings.agent.api')}</span>
        {/* Not inferred from the URL: a gateway can serve either shape from any
            path, and guessing wrong fails at the first token instead of here. */}
        <Segmented
          label={t('settings.agent.api')}
          value={api}
          options={AGENT_ENDPOINT_APIS.map((id) => ({ value: id, label: t(`settings.agent.api.${id}`) }))}
          onChange={setApi}
        />
      </div>

      <div className="form-row">
        <label htmlFor="peek-agent-key">{t('settings.agent.apiKey')}</label>
        <input
          id="peek-agent-key"
          type="password"
          className="mono"
          value={apiKey}
          spellCheck={false}
          placeholder={agent.endpointApiKeySet ? t('settings.agent.apiKeyStored') : t('settings.agent.apiKeyNone')}
          onChange={(e) => {
            setApiKey(e.target.value)
          }}
        />
      </div>
      <div className="form-hint">{t('settings.agent.apiKeyHint')}</div>

      <div className="form-row form-actions">
        <Button
          disabled={busy || !complete}
          onClick={() => {
            onWrite({
              endpoint: { baseUrl: baseUrl.trim(), model: model.trim(), api },
              // Omitted when empty, so saving the model does not erase a stored
              // key. Clearing one is its own button.
              ...(apiKey === '' ? {} : { endpointApiKey: apiKey }),
            })
            setApiKey('')
          }}
        >
          {t('settings.agent.save')}
        </Button>
        {agent.endpointApiKeySet ? (
          <Button
            disabled={busy}
            onClick={() => {
              onWrite({ endpointApiKey: '' })
            }}
          >
            {t('settings.agent.forgetKey')}
          </Button>
        ) : null}
      </div>
    </>
  )
}

/** Drop the members a caller left out, so a partial edit stays partial on the wire. */
function buildAgentPatch(patch: {
  backend?: AgentBackend
  permissionMode?: AgentDefaultPermissionMode
  acpProfile?: string
  acpExecutablePath?: string
  endpoint?: { baseUrl: string; model: string; api: (typeof AGENT_ENDPOINT_APIS)[number] }
  endpointApiKey?: string
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
