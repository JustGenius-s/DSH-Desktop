/** Electron 入口。TLS 兼容补丁必须早于所有主进程模块、app.whenReady 和建窗。 */
import './main/platform/macos-node-ca'
import './main/app'
