// 系统托盘
const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const { get } = require('./config')
const { acceleratorToDisplay } = require('../renderer/accelerator')
const I18n = require('../shared/i18n')

// handlers.getLang：由主进程注入，返回当前语言（'zh' | 'en'）
function createTray(handlers) {
  // 真实托盘图标：16px(1x) + 32px(2x)，高 DPI 下清晰
  const icon16 = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray16.png'))
  const icon32 = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
  let icon = icon16
  if (!icon16.isEmpty() && !icon32.isEmpty()) {
    icon16.addRepresentation({ scaleFactor: 2.0, width: 32, height: 32, buffer: icon32.toPNG() })
    icon = icon16
  }
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)

  // 每次取文案时都读当前语言，切换语言后 refresh() 即可生效
  function t(key, params) {
    const lang = (handlers.getLang && handlers.getLang()) || I18n.DEFAULT_LANG
    return I18n.t(lang, key, params)
  }

  function shortcutLabel() {
    return acceleratorToDisplay(get('shortcut')) || t('common.notSet')
  }

  function buildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: t('tray.capture', { shortcut: shortcutLabel() }), click: handlers.onCapture },
      { type: 'separator' },
      { label: t('tray.settings'), click: handlers.onSettings },
      { type: 'separator' },
      { label: t('tray.quit'), click: handlers.onQuit }
    ])
    tray.setContextMenu(menu)
  }

  function refresh() {
    buildMenu()
    tray.setToolTip(t('tray.tooltip', { shortcut: shortcutLabel() }))
  }

  refresh()
  // 左键单击托盘也触发截屏
  tray.on('click', handlers.onCapture)

  // 暴露 refresh：快捷键 / 语言变更后更新菜单与提示
  tray.refresh = refresh
  return tray
}

module.exports = { createTray }
