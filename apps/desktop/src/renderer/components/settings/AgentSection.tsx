import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  AGENT_DEFAULT_PERMISSION_MODES,
  AGENT_ENDPOINT_APIS,
  AGENT_MCP_TRANSPORTS,
  type AgentBackend,
  type AgentDefaultPermissionMode,
  type AgentMcpServerInfo,
  type AgentMcpTransport,
  type AgentSettingsReadResult,
} from '@peek/core'
import { tryBridge } from '../../bridge'
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
          {/* Every mode, the two that stop asking included. They were absent
              until 2026-08-15 on the grounds that a settings file is where you
              forget things — which was true, and was answered by making the
              panel mark an inherited mode rather than by refusing to store one.
              Re-picking on every new conversation was the cost being paid. */}
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

        {/* ACP only. The endpoint backend takes its tools straight from peek's
            own MCP registry as function handles — there is no client to point at
            a server with, so this would be a form that saves and does nothing.
            See the design doc §4.5. */}
        {agent.backend === 'acp' ? <McpServerList agent={agent} busy={busy} onWrite={write} /> : null}

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
            label: profile.available
              ? profile.displayName
              : `${profile.displayName} — ${t('settings.agent.missing')}`,
            disabled: !profile.available,
          }))}
          onChange={(acpProfile) => {
            onWrite({ acpProfile })
          }}
        />
      </FormRow>

      <FormRow label={t('settings.agent.fullTools')} hint={t('settings.agent.restartHint')}>
        {/* `Segmented`, not a checkbox — peek has no checkbox primitive and this
            is not the section to invent one (`ui/CLAUDE.md`, and the same call
            `NotificationsSection` made). Off/On also reads better than a tick
            for a switch whose consequence is a paragraph. */}
        <Segmented
          className="grow-0 shrink-0 basis-auto min-w-50"
          label={t('settings.agent.fullTools')}
          value={agent.acpFullTools ? 'on' : 'off'}
          options={[
            { value: 'off', label: t('settings.agent.fullTools.off') },
            { value: 'on', label: t('settings.agent.fullTools.on') },
          ]}
          onChange={(value) => {
            onWrite({ acpFullTools: value === 'on' })
          }}
        />
      </FormRow>

      {/* What the switch costs, said once and plainly.

          No confirmation dialog, deliberately — the same bargain M8 struck for
          packages (PLAN §4: what you install runs, and the note beside the
          control is the whole of it). A dialog here would imply peek is holding
          a gate it does not hold.

          `warn`, unlike the two notes below it: those describe a sandbox that is
          in place, this describes one that is not. */}
      {selected?.sandbox === 'relaxed' ? (
        <FormHint tone="warn">{t('settings.agent.relaxed')}</FormHint>
      ) : null}

      {/* This line was written to stand out — `unverified` means peek has no
          probe that its sandbox took — and for two rounds it could not: the
          class it reached for was never defined, and once that was noticed the
          colour was unreachable anyway, because the form rules outranked every
          utility from outside the cascade layers.

          A tone is reachable now, and this one is still a plain note. Whether
          an unprobed sandbox should read as a warning is a design decision, and
          it stays where it was left rather than being made in passing by the
          change that removed the obstacle.

          Keyed off `baseSandbox`, so it survives the switch: "peek never
          verified this agent" stays true, and stays said, when the tier above
          has moved to `relaxed`. The `enforced` line is the other way round —
          it is a claim about restrictions that are in force, so it goes quiet
          the moment they are not. */}
      {selected?.baseSandbox === 'unverified' ? (
        <FormHint>{t('settings.agent.unverified', { agent: selected.displayName })}</FormHint>
      ) : selected?.sandbox === 'enforced' ? (
        <FormHint>{t('settings.agent.enforced')}</FormHint>
      ) : null}

      <FormHint>{t('settings.agent.loginHint')}</FormHint>

      {/* Shown whether or not the tools are on, rather than appearing with the
          switch. A setting that materialises when another one is flipped is a
          setting nobody knows exists — and this one is worth knowing about
          before the switch, since choosing where the agent works is most of what
          makes turning the tools on useful. */}
      <FormRow label={t('settings.agent.workdir')}>
        <div className="flex items-center gap-tight min-w-0">
          <span className="font-mono truncate" title={agent.agentWorkdir ?? agent.agentWorkdirDefault}>
            {agent.agentWorkdir ?? agent.agentWorkdirDefault}
          </span>
        </div>
      </FormRow>
      <FormActions>
        <Button
          disabled={busy}
          onClick={() => {
            const bridge = tryBridge()
            // Feature-probed even though `PeekBridge` requires it, for the reason
            // `PackagesSection` gives: `tryBridge` vouches only for `invoke` and
            // `getSnapshot`, and a preload older than this channel would take the
            // window down on a click.
            if (!bridge || typeof bridge.pickDirectory !== 'function') return
            void bridge.pickDirectory().then((dir) => {
              // Cancelled. Silent on purpose — the user closed a dialog they had
              // just opened, and a line saying so would be the panel narrating
              // its own inaction.
              if (dir !== null) onWrite({ agentWorkdir: dir })
            })
          }}
        >
          {t('settings.agent.workdirPick')}
        </Button>
        {agent.agentWorkdir === undefined ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              onWrite({ agentWorkdir: '' })
            }}
          >
            {t('settings.agent.workdirReset')}
          </Button>
        )}
      </FormActions>
      <FormHint>{t('settings.agent.workdirHint')}</FormHint>

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

      <FormRow
        label={t('settings.agent.model')}
        htmlFor="peek-agent-model"
        hint={t('settings.agent.modelHint')}
      >
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

      <FormRow
        label={t('settings.agent.apiKey')}
        htmlFor="peek-agent-key"
        hint={t('settings.agent.apiKeyHint')}
      >
        <input
          id="peek-agent-key"
          type="password"
          className="font-mono tabular-nums"
          value={apiKey}
          spellCheck={false}
          placeholder={
            agent.endpointApiKeySet ? t('settings.agent.apiKeyStored') : t('settings.agent.apiKeyNone')
          }
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
  acpFullTools?: boolean
  agentWorkdir?: string
  mcpServers?: McpServerDraft[]
  endpoint?: { baseUrl: string; model: string; api: (typeof AGENT_ENDPOINT_APIS)[number] }
  endpointApiKey?: string
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/* ================================================================== */
/* The user's own MCP servers                                          */
/* ================================================================== */

/**
 * One row as the form holds it.
 *
 * `authValue` is the only field that differs from what comes back, and the
 * difference is the whole credential story: it goes **out** and never comes
 * back. `undefined` on save means "keep whatever is stored", `''` means "forget
 * it" — main matches by name to tell those apart, so editing a URL cannot
 * silently clear a token.
 */
interface McpServerDraft {
  name: string
  transport: AgentMcpTransport
  target: string
  args?: string[]
  authHeader?: string
  authValue?: string
  enabled: boolean
}

/** What the form is allowed to send as a name, matching the schema in core. */
const MCP_NAME = /^[a-z0-9_-]+$/

/**
 * The MCP list: add, edit, enable, remove.
 *
 * ## Why the whole list is sent on every save
 *
 * Removing a row has to be expressible and a member-wise merge can only add —
 * the same reason `keybindings` is sent whole. The form always holds every row,
 * so the file cannot lose one the sender still had.
 *
 * ## Why the name is validated here as well as in core
 *
 * The name becomes a tool prefix (`mcp__<name>__<tool>`). Core refuses a bad one
 * and that is the guarantee; this is so the user finds out while typing rather
 * than by watching the agent ignore a server it cannot address.
 */
function McpServerList({ agent, busy, onWrite }: FormProps): ReactElement {
  const t = useT()
  /**
   * Local until saved, unlike every other control in this section.
   *
   * The rest are single values where optimistic-then-corrected costs nothing. A
   * list being edited is a different thing: adopting main's answer on each
   * keystroke would fight the half-typed row, and a row that does not validate
   * yet has nowhere to live in the settings file.
   */
  const [rows, setRows] = useState<McpServerDraft[] | null>(null)
  const current = rows ?? agent.mcpServers.map(toDraft)
  const dirty = rows !== null

  const edit = (index: number, patch: Partial<McpServerDraft>): void => {
    setRows(current.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  const duplicate = (name: string, index: number): boolean =>
    current.some((row, i) => i !== index && row.name === name)
  const invalid = current.some(
    (row, i) => !MCP_NAME.test(row.name) || row.target.trim() === '' || duplicate(row.name, i),
  )

  return (
    <>
      <FormRow label={t('settings.agent.mcp')}>
        <span className="text-fg-dim">
          {current.length === 0
            ? t('settings.agent.mcp.none')
            : t('settings.agent.mcp.count', { count: current.length })}
        </span>
      </FormRow>

      {current.map((row, index) => (
        <FormRow key={index} label={row.name || t('settings.agent.mcp.unnamed')}>
          <div className="flex flex-col gap-tight min-w-0">
            <div className="flex items-center gap-tight min-w-0">
              <input
                className="font-mono min-w-0 flex-1"
                value={row.name}
                spellCheck={false}
                placeholder={t('settings.agent.mcp.namePlaceholder')}
                aria-label={t('settings.agent.mcp.name')}
                aria-invalid={!MCP_NAME.test(row.name) || duplicate(row.name, index)}
                onChange={(e) => {
                  edit(index, { name: e.target.value })
                }}
              />
              <Segmented
                className="grow-0 shrink-0 basis-auto"
                label={t('settings.agent.mcp.transport')}
                value={row.transport}
                options={AGENT_MCP_TRANSPORTS.map((transport) => ({
                  value: transport,
                  label: t(`settings.agent.mcp.transport.${transport}`),
                }))}
                onChange={(transport) => {
                  edit(index, { transport })
                }}
              />
              <Segmented
                className="grow-0 shrink-0 basis-auto"
                label={t('settings.agent.mcp.enabled')}
                value={row.enabled ? 'on' : 'off'}
                options={[
                  { value: 'off', label: t('settings.agent.fullTools.off') },
                  { value: 'on', label: t('settings.agent.fullTools.on') },
                ]}
                onChange={(value) => {
                  edit(index, { enabled: value === 'on' })
                }}
              />
              <Button
                variant="ghost"
                onClick={() => {
                  setRows(current.filter((_, i) => i !== index))
                }}
              >
                {t('settings.agent.mcp.remove')}
              </Button>
            </div>
            <input
              className="font-mono"
              value={row.target}
              spellCheck={false}
              aria-label={t('settings.agent.mcp.target')}
              placeholder={t(`settings.agent.mcp.targetPlaceholder.${row.transport}`)}
              onChange={(e) => {
                edit(index, { target: e.target.value })
              }}
            />
            {/* stdio authenticates by being a process peek starts, so a header
                would be a field with nowhere to go. */}
            {row.transport === 'http' ? (
              <div className="flex items-center gap-tight min-w-0">
                <input
                  className="font-mono min-w-0 basis-1/3"
                  value={row.authHeader ?? ''}
                  spellCheck={false}
                  aria-label={t('settings.agent.mcp.authHeader')}
                  placeholder="Authorization"
                  onChange={(e) => {
                    edit(index, { authHeader: e.target.value })
                  }}
                />
                <input
                  type="password"
                  className="font-mono min-w-0 flex-1"
                  value={row.authValue ?? ''}
                  spellCheck={false}
                  aria-label={t('settings.agent.mcp.authValue')}
                  // Never echoed, so the placeholder is the only thing that can
                  // say a credential exists — an empty box otherwise reads as
                  // "there is none", and the user retypes one that was fine.
                  placeholder={
                    agent.mcpServers.find((s) => s.name === row.name)?.authValueSet
                      ? t('settings.agent.apiKeyStored')
                      : t('settings.agent.mcp.authValuePlaceholder')
                  }
                  onChange={(e) => {
                    edit(index, { authValue: e.target.value })
                  }}
                />
              </div>
            ) : null}
          </div>
        </FormRow>
      ))}

      <FormActions>
        <Button
          disabled={busy}
          onClick={() => {
            setRows([...current, { name: '', transport: 'http', target: '', enabled: true }])
          }}
        >
          {t('settings.agent.mcp.add')}
        </Button>
        <Button
          disabled={busy || !dirty || invalid}
          onClick={() => {
            onWrite({ mcpServers: current })
            // Back to whatever main says it stored. The reply is the truth about
            // the file, and a row it dropped should disappear from the form
            // rather than sit there looking saved.
            setRows(null)
          }}
        >
          {t('settings.agent.save')}
        </Button>
        {dirty ? (
          <Button
            disabled={busy}
            onClick={() => {
              setRows(null)
            }}
          >
            {t('settings.agent.mcp.discard')}
          </Button>
        ) : null}
      </FormActions>
      <FormHint tone={invalid ? 'warn' : 'note'}>
        {invalid ? t('settings.agent.mcp.invalid') : t('settings.agent.mcp.hint')}
      </FormHint>
    </>
  )
}

/** Stored row → draft. The credential is not in the stored row and must not be invented. */
function toDraft(server: AgentMcpServerInfo): McpServerDraft {
  return {
    name: server.name,
    transport: server.transport,
    target: server.target,
    enabled: server.enabled,
    ...(server.args ? { args: server.args } : {}),
    ...(server.authHeader ? { authHeader: server.authHeader } : {}),
  }
}
