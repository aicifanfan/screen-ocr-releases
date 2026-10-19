// 系统托盘
const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const { get } = require('./config')
const { acceleratorToDisplay } = require('../renderer/accelerator')

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

  function shortcutLabel() {
    return acceleratorToDisplay(get('shortcut'))
  }

  function buildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: '截屏识别（' + shortcutLabel() + '）', click: handlers.onCapture },
      { type: 'separator' },
      { label: '设置…', click: handlers.onSettings },
      { type: 'separator' },
      { label: '退出', click: handlers.onQuit }
    ])
    tray.setContextMenu(menu)
  }

  function refresh() {
    buildMenu()
    tray.setToolTip('截屏 OCR — 按 ' + shortcutLabel() + ' 截屏识别文字')
  }

  refresh()
  // 左键单击托盘也触发截屏
  tray.on('click', handlers.onCapture)

  // 暴露 refresh：快捷键变更后更新菜单与提示
  tray.refresh = refresh
  return tray
}

module.exports = { createTray }
