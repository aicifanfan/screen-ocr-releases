// 自动更新模块：封装 electron-updater，仅在打包环境（app.isPackaged）生效
// 运行时从打包时生成的 resources/app-update.yml 读取 provider/owner/repo 等配置
const { app, dialog, BrowserWindow } = require('electron')
const { autoUpdater } = require('electron-updater')

let onStatus = null // (statusObj) => void，用于把状态推送给设置页

function emit(status) {
  try { if (onStatus) onStatus(status) } catch { /* 忽略回调异常 */ }
}

function isPackaged() { return !!app.isPackaged }

function setup(opts) {
  onStatus = (opts && opts.onStatus) || null

  autoUpdater.autoDownload = true         // 检查到新版本即自动下载
  autoUpdater.autoInstallOnAppQuit = true // 退出时自动安装（兜底）

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => emit({ state: 'available', info }))
  autoUpdater.on('update-not-available', (info) => emit({ state: 'none', info }))
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', info })
    promptInstall()
  })
  autoUpdater.on('error', (err) => emit({ state: 'error', message: (err && err.message) || String(err) }))
}

function checkForUpdates() {
  if (!isPackaged()) {
    emit({ state: 'error', message: '开发模式不支持自动更新，请安装正式版后使用' })
    return
  }
  autoUpdater.checkForUpdates().catch((e) => emit({ state: 'error', message: (e && e.message) || String(e) }))
}

// 下载完成后弹窗确认是否立即重启安装
function promptInstall() {
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    type: 'info',
    title: '更新就绪',
    message: '新版本已下载完成',
    detail: '点击「立即重启」马上安装并重启应用；或选择「稍后」，退出时自动安装。',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1
  }
  const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
  p.then(({ response }) => {
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall())
  }).catch(() => {})
}

module.exports = { setup, checkForUpdates, isPackaged }
