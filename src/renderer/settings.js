// 设置页逻辑：快捷键录制 + 开关项 + 语言切换 + 保存
const DEFAULTS = { shortcut: 'CommandOrControl+Shift+A', autoLaunch: false, captureOnLaunch: false, autoCloseAfterCopy: true, autoCheckUpdate: true, ocrProfile: 'balanced', language: 'auto' }

const hotkeyBox = document.getElementById('hotkey-box')
const hotkeyText = document.getElementById('hotkey-text')
const hotkeyReset = document.getElementById('hotkey-reset')
const optAutoLaunch = document.getElementById('opt-autolaunch')
const optCaptureLaunch = document.getElementById('opt-capture-launch')
const optAutoClose = document.getElementById('opt-auto-close')
const optAutoCheck = document.getElementById('opt-auto-check')
const optGpu = document.getElementById('opt-gpu')
const optOcrProfile = document.getElementById('opt-ocr-profile')
const optLanguage = document.getElementById('opt-language')
const appVersion = document.getElementById('app-version')
const btnCheckUpdate = document.getElementById('btn-check-update')
const updateStatus = document.getElementById('update-status')
const btnSave = document.getElementById('btn-save')
const btnCancel = document.getElementById('btn-cancel')
const hint = document.getElementById('hint')

// —— 语言 ——
// 主进程在 preload 阶段同步注入当前语言，因此首屏直接是正确的语言
let lang = I18n.normalizeLang(window.api.initialLanguage)
let lastUpdateStatus = null // 最近一次更新状态（切换语言时按新语言重绘）
function t(key, params) { return I18n.t(lang, key, params) }

// 当前语言下重新渲染所有文案（静态 data-i18n + 动态片段）
function applyLanguage(next) {
  if (next) lang = I18n.normalizeLang(next)
  I18n.applyDom(document, lang)
  document.title = t('settings.title')
  displayShortcut(pendingShortcut)
  renderUpdateStatus(lastUpdateStatus)
}

// 主进程广播语言变更 → 就地重绘，不刷新页面
window.api.onLanguageChanged((payload) => {
  if (!payload) return
  if (payload.setting) optLanguage.value = payload.setting
  applyLanguage(payload.lang)
})

// 切换语言：立即生效（不需要点保存）
optLanguage.addEventListener('change', async () => {
  const setting = optLanguage.value
  // 显式语言可先本地渲染（即时反馈）；auto 需要主进程按系统语言解析，避免闪一下再纠正
  if (setting === 'zh' || setting === 'en') applyLanguage(setting)
  try {
    const r = await window.api.setLanguage(setting)
    if (r && r.lang) applyLanguage(r.lang)
  } catch (e) {
    showHint(t('settings.saveFailedWith', { message: (e && e.message) || t('error.unknown') }), true)
  }
})

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
  hotkeyText.textContent = Accelerator.acceleratorToDisplay(acc) || t('common.notSet')
  hotkeyText.classList.toggle('kbd', !acc)
}

function startRecording() {
  recording = true
  hotkeyBox.classList.add('recording')
  hotkeyText.textContent = t('settings.hotkey.recording')
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
  if (!pendingShortcut) { showHint(t('settings.needShortcut'), true); startRecording(); return }
  const partial = {
    shortcut: pendingShortcut,
    autoLaunch: optAutoLaunch.checked,
    captureOnLaunch: optCaptureLaunch.checked,
    autoCloseAfterCopy: optAutoClose.checked,
    autoCheckUpdate: optAutoCheck.checked,
    disableGpu: !optGpu.checked,
    // 档位白名单来自 shared/profiles.js（新增档位只改那一处）
    ocrProfile: window.Profiles ? window.Profiles.normalizeProfile(optOcrProfile.value) : optOcrProfile.value
  }
  try {
    const result = await window.api.setSettings(partial)
    if (result && result.ok) {
      showHint(t('settings.saved'))
      setTimeout(() => window.api.closeSettings(), 500)
    } else if (result && result.errorCode === 'shortcutOccupied') {
      showHint(t('settings.shortcutOccupied'), true)
    } else {
      showHint(t('settings.saveFailedWith', {
        message: (result && result.error) || t('error.unknown')
      }), true)
    }
  } catch (err) {
    showHint(t('settings.saveFailedWith', { message: (err && err.message) || t('error.unknown') }), true)
  }
})

// 取消
btnCancel.addEventListener('click', () => window.api.closeSettings())

// —— 关于与更新 ——
// 把主进程推送的状态翻译成当前语言的文案
function renderUpdateStatus(status) {
  lastUpdateStatus = status || null
  if (!status) { showUpdateStatus('', ''); return }
  switch (status.state) {
    case 'checking': showUpdateStatus(t('update.checking'), 'info'); break
    case 'available': showUpdateStatus(t('update.available', { version: (status.info && status.info.version) || '?' }), 'info'); break
    case 'downloading': showUpdateStatus(t('update.downloading', { percent: status.percent || 0 }), 'info'); break
    case 'downloaded': showUpdateStatus(t('update.downloaded'), 'ok'); break
    case 'none': showUpdateStatus(t('update.none'), 'ok'); break
    case 'error':
      // 主进程只给错误码/原始信息，文案在这里按语言生成
      if (status.code === 'devMode') showUpdateStatus(t('update.devMode'), 'error')
      else showUpdateStatus(t('update.error', { message: status.message || t('update.unknownError') }), 'error')
      break
  }
}

function showUpdateStatus(msg, kind) {
  updateStatus.textContent = msg
  updateStatus.className = 'update-status' + (kind ? ' ' + kind : '')
  updateStatus.style.display = msg ? 'block' : 'none'
}

// 订阅主进程推送的更新状态
window.api.onUpdateStatus((status) => {
  if (!status) return
  renderUpdateStatus(status)
})

btnCheckUpdate.addEventListener('click', () => {
  renderUpdateStatus({ state: 'checking' })
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

  optAutoLaunch.checked = !!cfg.autoLaunch
  optCaptureLaunch.checked = cfg.captureOnLaunch === true // 默认关闭：需用户主动触发截屏
  optAutoClose.checked = cfg.autoCloseAfterCopy !== false
  optAutoCheck.checked = cfg.autoCheckUpdate !== false
  optGpu.checked = cfg.disableGpu === false // 默认关闭：只有显式设为 false 才启用 GPU
  optOcrProfile.value = window.Profiles ? window.Profiles.normalizeProfile(cfg.ocrProfile) : (cfg.ocrProfile || 'balanced')
  optLanguage.value = I18n.normalizeSetting(cfg.language)

  // 首次渲染：先用主进程注入的语言，配置里的语言以主进程为准（避免不一致）
  applyLanguage(window.api.initialLanguage)

  // 显示版本号
  try {
    const v = await window.api.getAppVersion()
    appVersion.textContent = v ? 'v' + v : 'v—'
  } catch { appVersion.textContent = 'v—' }
}

init()
