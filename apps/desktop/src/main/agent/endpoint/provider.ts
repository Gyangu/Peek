/**
 * The user's endpoint, as something `pi-ai` can stream from.
 *
 * ## Why a custom provider rather than a built-in one
 *
 * `pi-ai` ships a long list of named providers, and none of them is the point
 * here. What peek promises this backend for is *your* endpoint — a vLLM on a
 * workstation, an Ollama on the laptop, a company gateway behind a URL that is
 * nobody's business but the user's. `createProvider` is the documented way to
 * say "this shape, at this address", and it covers every named provider's shape
 * as a side effect.
 *
 * ## What peek deliberately does not know
 *
 * The model's real context window, cost, or whether it can think. peek asks the
 * user for the two facts a caller cannot derive (`contextWindow`, `maxTokens`)
 * and defaults them conservatively, because the alternative — a table of model
 * ids — is a table that is wrong the week after it is written, and wrong in the
 * direction of truncating someone's conversation.
 *
 * `cost` is zeroed for the same reason: peek would be inventing a number. A
 * usage figure derived from a made-up price is worse than no figure, so the
 * chat panel reports tokens and not money for this backend.
 */

import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { peekError, type AgentEndpointSettings } from '@peek/core'

/** peek's provider id inside `pi-ai`. One provider, one model, per configuration. */
export const ENDPOINT_PROVIDER_ID = 'peek-endpoint'

/**
 * Conservative defaults for the two numbers only the endpoint really knows.
 *
 * Under-reading a context window costs some history; over-reading it costs the
 * turn, with an error from the server that names a limit the user never set.
 */
const DEFAULT_CONTEXT_WINDOW = 32_000
const DEFAULT_MAX_TOKENS = 4_096

/**
 * What a keyless endpoint sends instead of a credential.
 *
 * Both of `pi-ai`'s api implementations refuse to build a request with neither
 * an api key nor an auth header — `getClientApiKey` in `openai-completions`,
 * `assertRequestAuth` in `anthropic-messages`, both throwing
 * `No API key for provider`. That refusal is deliberate on their side, and the
 * header is the door they left open for auth that cannot be spelled as a key.
 * `"unused"` is `pi-ai`'s own sentinel for exactly this case, so the value is a
 * published constant rather than something peek invented.
 *
 * It is not a secret and it only ever travels to the URL the user typed. What it
 * does cost is a line of diagnosis — an endpoint that *does* want credentials now
 * answers 401 instead of failing before the socket opens — and `EndpointManager`
 * pays that back by saying "this endpoint is configured without an API key" when
 * an auth-shaped error comes back. See
 * `docs/design/2026-08-04-endpoint-keyless-and-stream-errors.md` §3.2.
 */
const KEYLESS_AUTHORIZATION = 'Bearer unused'

export interface EndpointModel {
  models: ReturnType<typeof createModels>
  model: Model<'openai-completions' | 'anthropic-messages'>
}

/**
 * Build the `pi-ai` model this backend streams through.
 *
 * `apiKey` is passed rather than read: this module never touches the settings
 * file or the keychain, which keeps the secret's whole path — keychain →
 * assembly → here → the HTTP request — short enough to read in one sitting.
 * A keyless endpoint (a local Ollama) resolves to a sentinel `authorization`
 * header rather than to an empty key: an empty one is both rejected by `pi-ai`
 * and rejected by some servers as `Authorization: Bearer `.
 */
export function buildEndpointModel(settings: AgentEndpointSettings, apiKey: string | null): EndpointModel {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw peekError('BAD_REQUEST', 'The chat endpoint has no base URL.', {
      detail: 'Set one in Settings → Chat agent.',
      retryable: false,
    })
  }

  const model = {
    id: settings.model,
    name: settings.model,
    api: settings.api,
    provider: ENDPOINT_PROVIDER_ID,
    baseUrl,
    // Whether the model reasons is the model's business, and asking the user to
    // declare it would be asking them to guess. `pi-ai` streams thinking blocks
    // when they arrive either way; this only governs whether it *requests* them.
    reasoning: false,
    input: ['text'] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS,
  } as Model<'openai-completions' | 'anthropic-messages'>

  const provider = createProvider({
    id: ENDPOINT_PROVIDER_ID,
    name: 'peek endpoint',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Chat endpoint API key',
        resolve: () =>
          Promise.resolve(
            apiKey === null || apiKey === ''
              ? // Lower-case on purpose: `pi-ai` looks the header up case-insensitively
                // but merges it into the client's default headers verbatim.
                { auth: { headers: { authorization: KEYLESS_AUTHORIZATION } }, source: 'keyless endpoint' }
              : { auth: { apiKey }, source: 'Chat endpoint API key' },
          ),
      },
    },
    models: [model],
    api: {
      'openai-completions': openAICompletionsApi(),
      'anthropic-messages': anthropicMessagesApi(),
    },
  })

  const models = createModels()
  models.setProvider(provider)
  return { models, model }
}
