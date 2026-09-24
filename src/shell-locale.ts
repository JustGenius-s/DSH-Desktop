/**
 * 壳菜单语言的来源：DSH web profile 补丁文档里的 locale 条目。
 *
 * 语言偏好是 DSH 网页侧的用户设置，落在 profile 补丁文档（用户可手改、
 * 属于稳定契约），而不是内部 settings 存储：
 *
 *   - id: locale
 *     name: "@deepseek-ai/dsh-client-locale"
 *     config:
 *       preference: zh
 *
 * 壳只读这一段，不认识别的字段；读不到就回落 `app.getLocale()` 的系统语言
 * （见 desktop-seats.ts 的 currentMenuLang）。不新增 IPC、不需要网页配合。
 *
 * 纯模块（只依赖 node:fs），便于 vitest 直接测（见 test/shell-locale.test.ts）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 壳支持的两档界面语言。 */
export type ShellLang = 'zh' | 'en'

/**
 * 任意语言标签（'zh' / 'zh-CN' / 'zh_CN' / 'en-US' / 'fr' …）收敛到两档：
 * zh 及其地区变体归中文，其余（含未知/空）一律英文。
 */
export function resolveShellLang(tag: string | undefined | null): ShellLang {
  const normalized = typeof tag === 'string' ? tag.trim() : ''
  return /^zh([_-]|$)/i.test(normalized) ? 'zh' : 'en'
}

/** 语言偏好所在文档（相对 DSH home）。 */
const LOCALE_PATCH_RELATIVE = join('profiles', 'web', 'cordis.patch.yml')

/** 语言偏好文档的绝对路径。 */
export function localePatchPath(dshHome: string): string {
  return join(dshHome, LOCALE_PATCH_RELATIVE)
}

/**
 * 当前界面语言：用户偏好优先，其次调用方给的系统语言。
 *
 * 这是壳侧语言的唯一真源——菜单（desktop-seats）和页面内弹窗文案
 * （dsh-lifecycle）都从这里取，避免各处各判一次。
 *
 * 系统语言由调用方传入（`app.getLocale()`）：本模块不引 electron，
 * 才能被 vitest 直接测。
 * @param systemLocale - 系统语言；通常 `app.getLocale()`。
 * @param home - DSH home；默认 `$DSH_HOME` 或 `~/.dsh`。
 */
export function currentShellLang(systemLocale: string | undefined, home = dshHomeDir()): ShellLang {
  const preferred = readLocalePreference(localePatchPath(home))
  return resolveShellLang(preferred ?? systemLocale)
}

/** DSH home（与 CLI 约定一致：`$DSH_HOME` 或 `~/.dsh`）。 */
export function dshHomeDir(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 读语言偏好；文件缺失 / 不可读 / 条目没写值都返回 undefined，
 * 由调用方决定回落（壳用系统语言）。
 */
export function readLocalePreference(patchPath: string): string | undefined {
  try {
    return parseLocalePreference(readFileSync(patchPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 从补丁文档里取 `id: locale` 条目的 `config.preference`。
 *
 * 补丁是分层的，同一条目可能出现多次，**最后一个生效**（后写的覆盖先写的），
 * 所以按顺序扫、以最后一个匹配为准。手写解析是为了不引 YAML 依赖，代价是
 * 只认下面这几种形状：
 *
 *   - id: locale                        # 块式（DSH 写出来的就是这种）
 *     config:
 *       preference: zh
 *   - id: locale
 *     config: { preference: zh }        # 内联映射
 *   - { id: locale, config: { preference: zh } }   # 整条流式
 */
export function parseLocalePreference(patch: string): string | undefined {
  const lines = patch.split(/\r?\n/)
  let value: string | undefined
  for (let i = 0; i < lines.length; i += 1) {
    const indent = localeEntryIndent(lines[i])
    if (indent === null) continue
    const head = lines[i]
    const afterId = head.slice(head.indexOf('id:') + 3)
    if (afterId.includes('{') || afterId.includes(',')) {
      // 整条声明在一行里（流式），config 也内联。
      value = flowPreference(afterId)
      continue
    }
    // 条目块：直到同级或更浅的下一个列表项。
    let end = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isListItem(lines[j]) && indentOf(lines[j]) <= indent) {
        end = j
        break
      }
    }
    value = blockPreference(lines.slice(i + 1, end))
    i = end - 1
  }
  return value
}

/** 匹配「列表项声明的 id 恰好是 locale」的行（块式或流式），返回缩进宽度。 */
function localeEntryIndent(line: string): number | null {
  const m = /^(\s*)[-{]\s*\{?\s*id:\s*['"]?locale['"]?\s*(?:,|\}|\{|#|$)/.exec(line)
  return m === null ? null : m[1].length
}

function isListItem(line: string): boolean {
  return /^\s*-\s/.test(line)
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line)
  return m === null ? 0 : m[1].length
}

/** 在条目块里找 `config:` 段的 `preference`。 */
function blockPreference(block: string[]): string | undefined {
  let inConfig = false
  let configIndent = -1
  for (const line of block) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = indentOf(line)
    if (!inConfig) {
      if (!/^config:\s*/.test(trimmed)) continue
      inConfig = true
      configIndent = indent
      const rest = trimmed.slice('config:'.length).trim()
      const inline = flowPreference(rest)
      if (inline !== undefined) return inline
      // `config: { ... }` 里没写 preference：这一条没给出偏好。
      if (rest !== '') return undefined
      continue
    }
    // config 段结束（回到同级或更浅）仍未见到 preference。
    if (indent <= configIndent) return undefined
    const pm = /^preference:\s*(.*)$/.exec(trimmed)
    if (pm !== null) return cleanScalar(pm[1])
  }
  return undefined
}

/** 内联映射 / 单行里的 `preference: <value>`。 */
function flowPreference(text: string): string | undefined {
  const m = /preference\s*:\s*([^,}]+)/.exec(text)
  return m === null ? undefined : cleanScalar(m[1])
}

/** 去注释、去引号；空值 / null / ~ 视为「没写」。 */
function cleanScalar(raw: string): string | undefined {
  const value = raw
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
  if (value === '' || value === 'null' || value === '~') return undefined
  return value
}
