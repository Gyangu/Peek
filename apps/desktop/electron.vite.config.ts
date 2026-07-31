import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const rootDir = __dirname
// monorepo 根，用于把 @peek/* 直接指向源码（无需先 build）
const repoRoot = resolve(rootDir, '../..')

const peekAlias = {
  '@peek/core': resolve(repoRoot, 'packages/core/src/index.ts'),
  '@peek/driver-postgres': resolve(repoRoot, 'packages/driver-postgres/src/index.ts'),
}

export default defineConfig({
  // main：Electron 主进程。承载 Command Bus、Workspace 真源、MCP HTTP Server。
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@peek/core', '@peek/driver-postgres'] })],
    resolve: { alias: peekAlias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          // 主进程入口
          index: resolve(rootDir, 'src/main/index.ts'),
          // driver host：每个连接一个 utilityProcess，由 main fork 出来
          'driver-host': resolve(rootDir, 'src/main/driver-host/entry.ts'),
        },
      },
    },
  },

  // preload：只暴露一条窄桥（invoke / onPatch / onResultPort）
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

  // renderer：React 界面。root 指到 app 包根目录，index.html 在那儿。
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
      // 冷启动预算 < 1.5s，预打包这些重依赖
      warmup: { clientFiles: ['./src/renderer/main.tsx'] },
    },
  },
})
