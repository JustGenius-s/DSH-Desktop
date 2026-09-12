import { defineConfig } from 'vitest/config'

/**
 * 只收 TypeScript 测试。
 *
 * 仓库里同时有两类测试：上游迁到 vitest 的 `test/*.test.ts`，和本分支用
 * `node:test` 写的 `test/*.test.cjs`。vitest 收集后者会报
 * 「No test suite found in file」，所以默认 include 必须收窄；cjs 那批继续
 * 由 `node --test` 跑（见 package.json 的 test 脚本）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
