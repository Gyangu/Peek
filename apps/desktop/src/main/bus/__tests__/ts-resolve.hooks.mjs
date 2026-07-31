import { registerHooks } from 'node:module'

/**
 * node:test 跑 TypeScript 源码用的解析钩子（零依赖）。
 *
 * Node 自带类型擦除，但 ESM 解析要求相对导入带扩展名；
 * 而本仓库按 bundler 解析约定写的是无扩展名导入。
 * 这里在解析失败时依次补 `.ts` 与 `/index.ts`。
 *
 * 用法（在 apps/desktop 目录下）：
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
