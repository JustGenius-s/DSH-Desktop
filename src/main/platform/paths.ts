import { app } from 'electron'
import { join } from 'node:path'

/** 以应用根目录定位入口，避免功能模块搬迁改变 __dirname 后找错 preload。 */
export function preloadPath(): string {
  return join(app.getAppPath(), 'dist', 'preload.js')
}
