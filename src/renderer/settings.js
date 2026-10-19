// 设置页逻辑：快捷键录制 + 开关项 + 保存
const DEFAULTS = { shortcut: 'CommandOrControl+Shift+A', autoLaunch: false, captureOnLaunch: true, autoCloseAfterCopy: true, autoCheckUpdate: true }

const hotkeyBox = document.getElementById('hotkey-box')
const hotkeyText = document.getElementById('hotkey-text')
const hotkeyReset = document.getElementById('hotkey-reset')
const optAutoLaunch = document.getElementById('opt-autolaunch')
const optCaptureLaunch = document.getElementById('opt-capture-launch')
const optAutoClose = document.getElementById('opt-auto-close')
const optAutoCheck = document.getElementById('opt-auto-check')
const appVersion = document.getElementById('app-version')
const btnCheckUpdate = document.getElementById('btn-check-update')
const updateStatus = document.getElementById('update-status')
const btnSave = document.getElementById('btn-save')
const btnCancel = document.getElementById('btn-cancel')
const hint = document.getElementById('hint')

// —— 界面缩放（放大/缩小）——
const zoomOut = document.getElementById('zoom-out')
const zoomIn = document.getElementById('zoom-in')
const zoomReset = document.getElementById('zoom-reset')
const zoomVal = document.getElementById('zoom-val')

const ZOOM_MIN_RATIO = 0.75   // 相对基础缩放的最小比例
const ZOOM_MAX_RATIO = 2.0    // 相对基础缩放的最大比例
const ZOOM_STEP_RATIO = 0.1   // 每次步进比例

// 基础缩放因子：主进程在 did-finish-load 时按系统 DPI 补偿设置（force=1 下 screen.scaleFactor 恒为 1）。
// 此处延迟到首次交互才读取，避免在 did-finish-load 前误读默认值 1。
let zoomBase = null
function getBase() {
  if (zoomBase === null) zoomBase = window.api.getZoomFactor() || 1
  return zoomBase
}
function currentFactor() { return window.api.getZoomFactor() || 1 }
function updateZoomLabel() {
  zoomVal.textContent = Math.round((currentFactor() / getBase()) * 100) + '%'
}
function applyZoom(factor) {
  const base = getBase()
  const clamped = Math.min(base * ZOOM_MAX_RATIO, Math.max(base * ZOOM_MIN_RATIO, factor))
  window.api.setZoomFactor(clamped)
  updateZoomLabel()
}

zoomIn.addEventListener('click', () => applyZoom(currentFactor() + getBase() * ZOOM_STEP_RATIO))
zoomOut.addEventListener('click', () => applyZoom(currentFactor() - getBase() * ZOOM_STEP_RATIO))
zoomReset.addEventListener('click', () => applyZoom(getBase()))

// Ctrl+滚轮 缩放
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  const dir = e.deltaY < 0 ? 1 : -1
  applyZoom(currentFactor() + dir * getBase() * ZOOM_STEP_RATIO)
}, { passive: false })

// Ctrl+= / Ctrl+- / Ctrl+0 缩放快捷键
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  const k = e.key
  if (k === '=' || k === '+') { e.preventDefault(); applyZoom(currentFactor() + getBase() * ZOOM_STEP_RATIO) }
  else if (k === '-') { e.preventDefault(); applyZoom(currentFactor() - getBase() * ZOOM_STEP_RATIO) }
  else if (k === '0') { e.preventDefault(); applyZoom(getBase()) }
})

let recording = false
let pendingShortcut = DEFAULTS.shortcut // 待保存的快捷键（accelerator）

function displayShortcut(acc) {
  hotkeyText.textContent = Accelerator.acceleratorToDisplay(acc) || '未设置'
  hotkeyText.classList.toggle('kbd', !acc)
}

function startRecording() {
  recording = true
  hotkeyBox.classList.add('recording')
  hotkeyText.textContent = '请按下组合键…'
}

function stopRecording(committed) {
  recording = false
  hotkeyBox.classList.remove('recording')
  if (!committed) displayShortcut(pendingShortcut)
}

function showHint(msg, isError) {
  hint.textContent = msg
  hint.style.color = isError ? 'var(--danger)' : '#16a34a'
  setTimeout(() => { hint.textContent = '' }, 2200)
}

// 点击录制框进入录制态
hotkeyBox.addEventListener('click', (e) => { e.stopPropagation(); startRecording() })

// 点击别处取消录制
document.addEventListener('click', (e) => {
  if (recording && !hotkeyBox.contains(e.target)) stopRecording(false)
})

// 全局捕获组合键
document.addEventListener('keydown', (e) => {
  if (!recording) return
  e.preventDefault()
  e.stopImmediatePropagation() // 阻止后续 Esc 关闭监听器，避免「取消录制」时误关窗口
  if (e.key === 'Escape') { stopRecording(false); return }
  if (e.key === 'Backspace' || e.key === 'Delete') { pendingShortcut = ''; displayShortcut(''); stopRecording(true); return }
  const acc = Accelerator.keyEventToAccelerator(e)
  if (acc) { pendingShortcut = acc; displayShortcut(acc); stopRecording(true) }
})

// 恢复默认快捷键
hotkeyReset.addEventListener('click', (e) => {
  e.stopPropagation()
  pendingShortcut = DEFAULTS.shortcut
  displayShortcut(pendingShortcut)
  stopRecording(false)
})

// 保存
btnSave.addEventListener('click', async () => {
  if (!pendingShortcut) { showHint('请先设置快捷键', true); startRecording(); return }
  const partial = {
    shortcut: pendingShortcut,
    autoLaunch: optAutoLaunch.checked,
    captureOnLaunch: optCaptureLaunch.checked,
    autoCloseAfterCopy: optAutoClose.checked,
    autoCheckUpdate: optAutoCheck.checked
  }
  try {
    const result = await window.api.setSettings(partial)
    if (result && result.ok) {
      showHint('已保存 ✓')
      setTimeout(() => window.api.closeSettings(), 500)
    } else {
      showHint((result && result.error) || '保存失败', true)
    }
  } catch (err) {
    showHint('保存失败：' + (err && err.message ? err.message : err), true)
  }
})

// 取消
btnCancel.addEventListener('click', () => window.api.closeSettings())

// —— 关于与更新 ——
function showUpdateStatus(msg, kind) {
  updateStatus.textContent = msg
  updateStatus.className = 'update-status' + (kind ? ' ' + kind : '')
  updateStatus.style.display = msg ? 'block' : 'none'
}

// 订阅主进程推送的更新状态
window.api.onUpdateStatus((status) => {
  if (!status) return
  switch (status.state) {
    case 'checking': showUpdateStatus('正在检查更新…', 'info'); break
    case 'available': showUpdateStatus('发现新版本 v' + (status.info && status.info.version) + '，开始下载…', 'info'); break
    case 'downloading': showUpdateStatus('正在下载更新 ' + (status.percent || 0) + '%', 'info'); break
    case 'downloaded': showUpdateStatus('新版本已下载，重启后生效', 'ok'); break
    case 'none': showUpdateStatus('已是最新版本', 'ok'); break
    case 'error': showUpdateStatus('更新失败：' + (status.message || '未知错误'), 'error'); break
  }
})

btnCheckUpdate.addEventListener('click', () => {
  showUpdateStatus('正在检查更新…', 'info')
  window.api.checkForUpdates()
})

// Esc 关闭（非录制态）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !recording) window.api.closeSettings()
})

// 初始化
async function init() {
  const cfg = (await window.api.getSettings()) || {}
  pendingShortcut = cfg.shortcut || DEFAULTS.shortcut
  displayShortcut(pendingShortcut)
  optAutoLaunch.checked = !!cfg.autoLaunch
  optCaptureLaunch.checked = cfg.captureOnLaunch !== false
  optAutoClose.checked = cfg.autoCloseAfterCopy !== false
  optAutoCheck.checked = cfg.autoCheckUpdate !== false

  // 显示版本号
  try {
    const v = await window.api.getAppVersion()
    appVersion.textContent = v ? 'v' + v : 'v—'
  } catch { appVersion.textContent = 'v—' }
}

init()
