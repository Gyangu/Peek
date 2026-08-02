// Resolution hook for `node --test`. Usage:
//   node --import ./src/__tests__/register.mjs --test src/__tests__/*.test.ts
//
// The repo standardises on moduleResolution=bundler, so relative imports carry no
// extension — a spelling node does not accept on its own. This hook probes for
// .ts / index.ts. Type stripping is node's own job; the hook only finds the file.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const CANDIDATES = ['.ts', '.mts', '.tsx', '/index.ts']

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const base = new URL(specifier, context.parentURL)
      for (const ext of CANDIDATES) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate.href, context)
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
