// 自动更新模块：封装 electron-updater，仅在打包环境（app.isPackaged）生效
// 运行时从打包时生成的 resources/app-update.yml 读取 provider/owner/repo 等配置
const { app, dialog, BrowserWindow } = require('electron')
const { autoUpdater } = require('electron-updater')
const I18n = require('../shared/i18n')

let onStatus = null // (statusObj) => void，用于把状态推送给设置页
// 译文函数由主进程注入（内部按当前语言取词）；未注入时退化为返回 key
let tr = (key) => key

function emit(status) {
  try { if (onStatus) onStatus(status) } catch { /* 忽略回调异常 */ }
}

function isPackaged() { return !!app.isPackaged }

function setup(opts) {
  onStatus = (opts && opts.onStatus) || null
  if (opts && typeof opts.t === 'function') tr = opts.t

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
    // 用错误码而非中文文案，渲染层按当前语言翻译
    emit({ state: 'error', code: 'devMode' })
    return
  }
  autoUpdater.checkForUpdates().catch((e) => emit({ state: 'error', message: (e && e.message) || String(e) }))
}

// 下载完成后弹窗确认是否立即重启安装
function promptInstall() {
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    type: 'info',
    title: tr('update.dialogTitle'),
    message: tr('update.dialogMessage'),
    detail: tr('update.dialogDetail'),
    buttons: [tr('update.restartNow'), tr('update.later')],
    defaultId: 0,
    cancelId: 1
  }
  const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)
  p.then(({ response }) => {
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall())
  }).catch(() => {})
}

module.exports = { setup, checkForUpdates, isPackaged }
