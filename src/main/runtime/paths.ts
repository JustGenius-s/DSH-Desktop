import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH home（与 CLI 约定一致：`$DSH_HOME` 或 `~/.dsh`）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 外置运行时安装根目录，CLI 与桌面版共用。 */
export function runtimeDir(): string {
  return join(dshHome(), 'runtime')
}
