import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const rootDir = __dirname
// Monorepo root, used to alias @peek/* straight at the sources (no build step first)
const repoRoot = resolve(rootDir, '../..')

const peekAlias = {
  '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/driver-postgres': resolve(repoRoot, 'packages/driver-postgres/src/index.ts'),
}

export default defineConfig({
  // main: the Electron main process. Hosts the Command Bus, the Workspace source of
  // truth, and the MCP HTTP server.
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@peek/core', '@peek/driver-postgres'] })],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          // Main-process entry point
          index: resolve(rootDir, 'src/main/index.ts'),
          // driver host: one utilityProcess per connection, forked by main
          'driver-host': resolve(rootDir, 'src/main/driver-host/entry.ts'),
        },
      },
    },
  },

  // preload: exposes one narrow bridge and nothing else (invoke / onPatch / onResultPort)
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@peek/core'] })],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(rootDir, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },

  // renderer: the React UI. root points at the app package root, where index.html lives.
  renderer: {
    root: rootDir,
    plugins: [react()],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(rootDir, 'index.html') },
      },
    },
    server: {
      // Cold-start budget is under 1.5s, so pre-bundle the heavy dependencies
      warmup: { clientFiles: ['./src/renderer/main.tsx'] },
    },
  },
})
