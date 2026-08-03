import { optionalDepStub } from './optional-dep-stub'

/**
 * Stub for `@opentelemetry/api`, aliased in electron.vite.config.ts.
 *
 * `@redis/client` reaches for it from `OpenTelemetry.init()`, which peek never
 * calls.
 */
export default optionalDepStub(
  '@opentelemetry/api',
  'Redis OpenTelemetry instrumentation is unavailable; do not call OpenTelemetry.init().',
)
