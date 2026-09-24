/**
 * 桌面壳自有菜单/托盘文案（中/英）。
 *
 * 菜单里的文字来自三处：
 * 1. 壳自己的条目：Edit / View / Restart DSH Service …（本文件取词）；
 * 2. Electron role 条目：About / Hide / Copy …——role 的默认文案永远是英文
 *    （Electron 不做本地化，`--lang=zh-CN` 也不变），必须显式传 label 才能换
 *    语言（本文件取词）；
 * 3. 插件贡献的条目：文案由贡献方自带，语言切换时贡献方重新 contribute。
 *
 * 语言来源见 ./shell-locale：用户设置优先（web profile 的 locale 偏好），
 * 没设置过时按系统语言。本模块只管文案，不关心语言从哪来。
 *
 * 纯模块、不引 electron，便于 vitest 直接测（见 test/menu-i18n.test.ts）。
 */

import type { ShellLang } from './shell-locale'

/** `{name}` 占位替换为应用名（About DSH-Desktop / 关于 DSH-Desktop …）。 */
export function withAppName(template: string, name: string): string {
  return template.replace('{name}', name)
}

/** 壳菜单/托盘全部自有文案。两档字典键集必须一致（单测守护）。 */
export interface MenuStrings {
  about: string
  hide: string
  hideOthers: string
  showAll: string
  quit: string
  /** 非 macOS 的 File 菜单退出项（Windows 惯例是 Exit，不带应用名）。 */
  exit: string
  file: string
  edit: string
  view: string
  window: string
  plugins: string
  restartService: string
  reload: string
  toggleFullScreen: string
  toggleDevTools: string
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  minimize: string
  zoom: string
  bringAllToFront: string
  trayShow: string

  /** 检查桌面版更新（应用菜单项 / 关于弹窗按钮共用）。 */
  /** 关于弹窗。 */
  /** 检查结果弹窗。 */
  /** 结果弹窗里的 DSH 运行时说明行。 */
}

const ZH: MenuStrings = {
  about: '关于 {name}',
  hide: '隐藏 {name}',
  hideOthers: '隐藏其他',
  showAll: '全部显示',
  quit: '退出 {name}',
  exit: '退出',
  file: '文件',
  edit: '编辑',
  view: '显示',
  window: '窗口',
  plugins: '插件',
  restartService: '重启 DSH 服务',
  reload: '重新加载',
  toggleFullScreen: '进入全屏幕',
  toggleDevTools: '切换开发者工具',
  undo: '撤销',
  redo: '重做',
  cut: '剪切',
  copy: '拷贝',
  paste: '粘贴',
  selectAll: '全选',
  minimize: '最小化',
  zoom: '缩放',
  bringAllToFront: '前置全部窗口',
  trayShow: '显示 {name}',
}

const EN: MenuStrings = {
  about: 'About {name}',
  hide: 'Hide {name}',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  quit: 'Quit {name}',
  exit: 'Exit',
  file: 'File',
  edit: 'Edit',
  view: 'View',
  window: 'Window',
  plugins: 'Plugins',
  restartService: 'Restart DSH Service',
  reload: 'Reload',
  toggleFullScreen: 'Toggle Full Screen',
  toggleDevTools: 'Toggle Developer Tools',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  minimize: 'Minimize',
  zoom: 'Zoom',
  bringAllToFront: 'Bring All to Front',
  trayShow: 'Show {name}',
}

/** 按语言取整套文案。 */
export function menuStrings(lang: ShellLang): MenuStrings {
  return lang === 'zh' ? ZH : EN
}
