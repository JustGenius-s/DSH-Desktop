/**
 * Dock 策略探针：模拟真实启动时序，检测各启动路径下 macOS 何时把
 * activation policy 从 regular 降级为 accessory / prohibited，
 * 以及现有 4 个断言点（ready / show / did-finish-load / +10s）是否兜得住。
 *
 * 用法：pnpm exec tsx scripts/dock-policy-probe.ts [scenario]
 *   scenario: gui(默认，双击/Spotlight) | cli-bg（等价 open -g 后台拉起）| hold（秒，观测降级是否在 10s 后发生）
 */
import { app, BrowserWindow, dialog } from 'electron'

const scenario = process.argv[2] ?? 'gui'
const holdSecs = Number(process.argv[3] ?? 20)

if (!app.isPackaged) {
  // 与 src/main.ts 一致的 dev 隔离
  app.setPath('userData', require('node:path').join(__dirname, '..', '.userdata-dev-probe'))
}

const t0 = Date.now()
const policyName = (p: string) => p
function probe(tag: string): void {
  // @ts-expect-error getActivationPolicy 在 Electron ≥ 27 存在
  const p = typeof app.getActivationPolicy === 'function' ? app.getActivationPolicy() : '(unknown)'
  console.log(`[probe] +${String(Date.now() - t0).padStart(6)}ms  ${tag}: policy=${p}`)
}

app.whenReady().then(() => {
  probe('whenReady')
  if (process.platform === 'darwin') app.setActivationPolicy('regular')
  probe('whenReady+setRegular')

  const win = new BrowserWindow({ width: 600, height: 400, show: false })
  win.once('ready-to-show', () => {
    probe('ready-to-show(pre-show)')
    win.show()
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('ready-to-show(post-show+setRegular)')
  })
  win.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('did-finish-load(+setRegular)')
  })

  // 轮询 100ms，看降级的确切时刻
  const timer = setInterval(() => probe('poll'), 100)
  setTimeout(() => clearInterval(timer), holdSecs * 1000)

  // 模拟 main.ts 的 +10s 兜底断言
  setTimeout(() => {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    probe('+10s setRegular')
  }, 10_000)

  void win.loadURL('about:blank')

  setTimeout(() => {
    probe('final')
    const p = (app as unknown as { getActivationPolicy?: () => string }).getActivationPolicy?.()
    if (p !== 'regular') {
      dialog.showErrorBox('Dock Probe', `最终策略=${p ?? '?'}（Dock 不可见）。详见终端日志。`)
    }
    app.quit()
  }, holdSecs * 1000 + 500)
})
