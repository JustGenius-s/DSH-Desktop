import { defineConfig } from 'vitest/config'

/**
 * 只收 TypeScript 测试。
 *
 * 仓库里同时有两类测试，各自保留自己的 runner：
 *
 *   - `test/unit/**\/*.test.ts`、`test/integration/**\/*.test.ts`：vitest，
 *     直接 import `src/` 下的模块（Electron 用 vi.mock 顶掉）。
 *   - `test/integration/**\/*.test.cjs`：`node:test`，只 require 构建后的
 *     `dist/` 产物和 `scripts/` 里的真实启动脚本，所以必须先 build。
 *
 * vitest 收集 `.cjs` 会报「No test suite found in file」，因此 include 必须收窄；
 * cjs 那批继续由 `node --test` 跑（见 package.json 的 test 脚本）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
