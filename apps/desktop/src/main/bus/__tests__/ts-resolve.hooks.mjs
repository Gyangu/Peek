import { registerHooks } from 'node:module'

/**
 * Resolution hooks that let node:test run TypeScript sources (zero dependencies).
 *
 * Node strips types on its own, but ESM resolution requires an extension on
 * relative imports, while this repository writes extensionless imports per the
 * bundler resolution convention. When resolution fails, this retries with `.ts`
 * and then with `/index.ts`.
 *
 * Usage (from apps/desktop):
 *   node --import ./src/main/bus/__tests__/ts-resolve.hooks.mjs --test "src/main/bus/__tests__/*.test.ts"
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
      try {
        return nextResolve(`${specifier}.ts`, context)
      } catch {
        return nextResolve(`${specifier}/index.ts`, context)
      }
    }
  },
})
