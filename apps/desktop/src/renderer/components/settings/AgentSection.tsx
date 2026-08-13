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
import { Form, FormActions, FormHint, FormRow } from '../../ui/Form'
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

  if (!agent) return <div className="text-fg-dim mb-snug">{t('settings.agent.intro')}</div>

  return (
    <>
      <div className="text-fg-dim mb-snug">{t('settings.agent.intro')}</div>

      <Form>
        <FormRow label={t('settings.agent.backend')} hint={t('settings.agent.restartHint')}>
          <Segmented
            className="grow-0 shrink-0 basis-auto min-w-50"
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
        </FormRow>

        <FormRow
          label={t('settings.agent.permissionMode')}
          hint={t(`settings.agent.modeHint.${agent.permissionMode}`)}
        >
          {/* The two ⚠ modes in the panel's own dropdown are deliberately absent
              here. Reaching for one on a conversation you are looking at is a
              decision; leaving one in a settings file is something you forget. */}
          <Segmented
            className="grow-0 shrink-0 basis-auto min-w-50"
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
        </FormRow>

        {/* Both halves are rows and hints, so they join this grid's columns
            rather than starting their own: a row is a fragment, and a component
            that returns one is still just two cells. Which is why the label
            column is measured across the whole section, backend picker included,
            and not per sub-form. */}
        {agent.backend === 'acp' ? (
          <AcpForm agent={agent} busy={busy} onWrite={write} />
        ) : (
          <EndpointForm agent={agent} busy={busy} onWrite={write} />
        )}

        {notice === null ? null : <FormHint>{notice}</FormHint>}
      </Form>
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
      <FormRow label={t('settings.agent.which')}>
        <Segmented
          className="grow-0 shrink-0 basis-auto min-w-50"
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
      </FormRow>

      {/* This line was written to stand out — `unverified` means peek has no
          probe that its sandbox took — and for two rounds it could not: the
          class it reached for was never defined, and once that was noticed the
          colour was unreachable anyway, because the form rules outranked every
          utility from outside the cascade layers.

          A tone is reachable now, and this one is still a plain note. Whether
          an unprobed sandbox should read as a warning is a design decision, and
          it stays where it was left rather than being made in passing by the
          change that removed the obstacle. */}
      {selected?.sandbox === 'unverified' ? (
        <FormHint>{t('settings.agent.unverified', { agent: selected.displayName })}</FormHint>
      ) : (
        <FormHint>{t('settings.agent.enforced')}</FormHint>
      )}

      <FormHint>{t('settings.agent.loginHint')}</FormHint>

      <FormRow label={t('settings.agent.executable')} htmlFor="peek-agent-exe">
        <input
          id="peek-agent-exe"
          className="font-mono tabular-nums"
          value={path}
          spellCheck={false}
          placeholder={t('settings.agent.executablePlaceholder')}
          onChange={(e) => {
            setPath(e.target.value)
          }}
        />
      </FormRow>
      <FormActions>
        <Button
          disabled={busy || path === (agent.acpExecutablePath ?? '')}
          onClick={() => {
            onWrite({ acpExecutablePath: path })
          }}
        >
          {t('settings.agent.save')}
        </Button>
      </FormActions>
      <FormHint>{t('settings.agent.executableHint')}</FormHint>
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
      <FormRow label={t('settings.agent.baseUrl')} htmlFor="peek-agent-url">
        <input
          id="peek-agent-url"
          className="font-mono tabular-nums"
          value={baseUrl}
          spellCheck={false}
          placeholder="http://localhost:11434/v1"
          onChange={(e) => {
            setBaseUrl(e.target.value)
          }}
        />
      </FormRow>

      <FormRow label={t('settings.agent.model')} htmlFor="peek-agent-model" hint={t('settings.agent.modelHint')}>
        <input
          id="peek-agent-model"
          className="font-mono tabular-nums"
          value={model}
          spellCheck={false}
          placeholder="qwen3-coder"
          onChange={(e) => {
            setModel(e.target.value)
          }}
        />
      </FormRow>

      <FormRow label={t('settings.agent.api')}>
        {/* Not inferred from the URL: a gateway can serve either shape from any
            path, and guessing wrong fails at the first token instead of here. */}
        <Segmented
          className="grow-0 shrink-0 basis-auto min-w-50"
          label={t('settings.agent.api')}
          value={api}
          options={AGENT_ENDPOINT_APIS.map((id) => ({ value: id, label: t(`settings.agent.api.${id}`) }))}
          onChange={setApi}
        />
      </FormRow>

      <FormRow label={t('settings.agent.apiKey')} htmlFor="peek-agent-key" hint={t('settings.agent.apiKeyHint')}>
        <input
          id="peek-agent-key"
          type="password"
          className="font-mono tabular-nums"
          value={apiKey}
          spellCheck={false}
          placeholder={agent.endpointApiKeySet ? t('settings.agent.apiKeyStored') : t('settings.agent.apiKeyNone')}
          onChange={(e) => {
            setApiKey(e.target.value)
          }}
        />
      </FormRow>

      <FormActions>
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
      </FormActions>
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
