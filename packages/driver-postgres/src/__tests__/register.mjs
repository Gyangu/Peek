// node --test 用的解析钩子。用法：
//   node --import ./src/__tests__/register.mjs --test src/__tests__/*.test.ts
//
// 仓库统一 moduleResolution=bundler，相对 import 不写扩展名；node 自己不认这种写法，
// 这里补上 .ts / index.ts 的探测。类型擦除由 node 内置完成，钩子只管"找到文件"。
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
