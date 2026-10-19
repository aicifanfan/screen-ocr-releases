// 主进程入口：窗口管理、IPC 调度、生命周期
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')
const { captureAllScreens } = require('./screen-capture')
const { OcrBridge } = require('./ocr-bridge')
const { registerShortcuts, updateShortcut, unregisterAll } = require('./shortcut')
const { createTray } = require('./tray')
const { copyText } = require('./clipboard')
const { getAll, update } = require('./config')
const { setup: setupUpdater, checkForUpdates } = require('./updater')
const log = require('./log')
const fs = require('fs')

log.init()

// —— GPU 崩溃自动降级 ——
// 若上次运行期间 GPU 进程崩溃过（部分显卡驱动 / 虚拟化环境下 Chromium 会
// "GPU process isn't usable. Goodbye." 直接结束主进程，表现为双击瞬间消失），
// 本次启动自动禁用硬件加速，保证程序能起来。
const GPU_FLAG = (() => { try { return require('path').join(app.getPath('userData'), 'gpu-crash.flag') } catch { return null } })()

function gpuCrashedBefore() {
  try { return !!GPU_FLAG && fs.existsSync(GPU_FLAG) } catch { return false }
}

function markGpuCrash(reason) {
  try {
    if (GPU_FLAG) fs.writeFileSync(GPU_FLAG, new Date().toISOString() + ' ' + reason + '\n')
  } catch { /* 忽略 */ }
}

// GPU 加速：默认关闭（稳定优先）。仅当用户显式开启且未发生过 GPU 崩溃时才启用。
let gpuOff = true
let gpuReason = '默认兼容模式'
let crashedBefore = false
try {
  const cfg = getAll()
  crashedBefore = gpuCrashedBefore()
  if (crashedBefore) {
    gpuOff = true
    gpuReason = '上次子进程崩溃过，自动降级'
  } else if (cfg.disableGpu === false) {
    gpuOff = false
    gpuReason = '用户开启 GPU 加速'
  }
} catch { /* 配置不可读 → 保持默认兼容模式 */ }

const isRdpSession = !!process.env.SESSIONNAME && /rdp/i.test(process.env.SESSIONNAME)
if (gpuOff || isRdpSession) app.disableHardwareAcceleration()

// 兜底：上次运行出现「GPU/渲染进程崩溃」（常见于安全软件拦截 Chromium 沙箱，
// 表现为双击后进程秒退、完全无反应）→ 本次关闭 Chromium 沙箱再试。
// no-sandbox 必须在 ready 前追加才生效。
if (crashedBefore) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-setuid-sandbox')
}

log.info('GPU 硬件加速: ' + (gpuOff || isRdpSession ? '关闭' : '开启') +
  ' | 原因=' + (isRdpSession ? '远程桌面会话' : gpuReason) +
  ' | rdp=' + isRdpSession + ' | 崩溃兜底(no-sandbox)=' + crashedBefore)

// 全局异常也要留痕，否则双击后闪退完全无迹可循
let crashInThisRun = false // 本次运行是否发生过子进程崩溃

process.on('uncaughtException', (e) => log.error('uncaughtException: ' + (e && e.stack ? e.stack : e)))
process.on('unhandledRejection', (e) => log.error('unhandledRejection: ' + (e && e.stack ? e.stack : e)))
// 判定「真崩溃」：排除被正常终止的情况（143/15 = SIGTERM，关闭窗口/退出时会触发）
function isAbnormalExit(d) {
  return d.reason === 'crashed' && d.exitCode !== 0 && d.exitCode !== 143 && d.exitCode !== 15
}

app.on('child-process-gone', (_e, d) => {
  log.error('子进程退出: type=' + d.type + ' reason=' + d.reason + ' exitCode=' + d.exitCode)
  // 只有 GPU 进程异常退出才触发降级（network/utility 等普通子进程崩溃不影响渲染）
  if (d.type === 'GPU' && isAbnormalExit(d)) {
    crashInThisRun = true
    markGpuCrash('type=' + d.type + ' reason=' + d.reason + ' exitCode=' + d.exitCode)
    log.warn('已标记 GPU 崩溃，下次启动将自动关闭硬件加速与 Chromium 沙箱')
  }
})
app.on('render-process-gone', (_e, _wc, d) => {
  log.error('渲染进程退出: reason=' + d.reason + ' exitCode=' + d.exitCode)
  if (isAbnormalExit(d)) {
    crashInThisRun = true
    markGpuCrash('renderer reason=' + d.reason + ' exitCode=' + d.exitCode)
    log.warn('已标记渲染进程崩溃，下次启动将自动关闭 Chromium 沙箱')
  }
})

// 关键：强制 deviceScaleFactor=1，让 CSS 像素 == 物理像素。
// 这样跨多块不同缩放比的屏时，窗口 bounds、鼠标坐标、canvas 全部统一为物理像素，
// 消除「窗口 DIP 坐标 vs 屏幕物理坐标不一致」导致的副屏框选偏移 / 跨屏框选失效。
app.commandLine.appendSwitch('force-device-scale-factor', '1')

// 单实例锁：避免多个实例并存抢快捷键/托盘（旧实例占住 Ctrl+Shift+A，新实例形同虚设）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在运行：直接退出，由已有实例响应 second-instance 弹出截屏
  app.quit()
} else {
  // 用户再次双击图标 → 已运行实例直接触发一次截屏
  app.on('second-instance', () => { onCapture() })
}

let overlayWins = []      // 遮罩选区窗口（一块屏一个，覆盖整个虚拟桌面；常驻复用，避免每次重建）
let overlayLayoutKey = '' // 当前遮罩窗口对应的屏幕布局签名（屏数/位置/分辨率变化时重建）
let overlayGeneration = 0 // 截图流程代数：每次开启/关闭递增，用于取消「已过期」的异步 reveal
let isQuitting = false    // 应用退出中：区分「关闭遮罩(隐藏)」与「退出时真正销毁窗口」
let resultWin = null  // 结果窗口
let settingsWin = null // 设置窗口
let tray = null
let resultData = null // 最近一次识别结果
// OCR 档位来自配置（默认 balanced：实测比默认参数快 9.4x，CER 从 9.09% 降到 2.16%）
let ocrProfile = 'balanced'
try { ocrProfile = getAll().ocrProfile || 'balanced' } catch { /* 配置不可读用默认 */ }
const ocr = new OcrBridge(ocrProfile)

const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js')

// —— 拖拽框选状态（主进程统一协调，支持跨屏无缝框选）——
let drag = null          // { startX, startY, curX, curY } 全局物理坐标
let dragTimer = null

function broadcast(channel, payload) {
  for (const w of overlayWins) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function startDragPolling() {
  stopDragPolling()
  dragTimer = setInterval(() => {
    if (!drag) return
    const p = screen.getCursorScreenPoint()
    drag.curX = p.x
    drag.curY = p.y
    broadcast('overlay:sync', { drag })
  }, 16)
}

function stopDragPolling() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
}

// 屏幕布局签名：屏数 + 每屏物理位置/尺寸。变化时需重建窗口。
function currentLayoutKey(cap) {
  return cap.displays
    .map((d) => d.physX + ',' + d.physY + ',' + d.pxWidth + ',' + d.pxHeight)
    .join('|')
}

// 是否有遮罩窗口正显示（用于 onCapture 防止重复触发）
function anyOverlayVisible() {
  return overlayWins.some((w) => w && !w.isDestroyed() && w.isVisible())
}

// 真正销毁全部遮罩窗口并重置状态（每次截屏前 / 关闭时 / 退出时调用）
function destroyOverlay() {
  stopDragPolling()
  drag = null
  for (const w of overlayWins) {
    if (w && !w.isDestroyed()) {
      w.removeAllListeners('close')
      w.removeAllListeners('closed')
      w.destroy()
    }
  }
  overlayWins = []
  overlayLayoutKey = ''
}

// 打开遮罩选区窗口：每块屏一个，各覆盖本屏物理边界（无边框、置顶）。
// 每次截屏都创建**全新窗口**，用完即销毁：
// 复用窗口（hide/show）会把上一次的截图画面与选区状态带到下一次，表现为「多层嵌套/叠加」，
// 因此这里不再复用，保证每次都是干净界面。
// 关键：跨屏超大窗口会被 Chromium 收缩到单屏工作区，故拆成「一块屏一个窗口」，
//       并在创建后 setBounds 纠正构造时被收缩到 workArea 的高度（保证盖满含任务栏）。
function showOverlay(cap) {
  const myGen = ++overlayGeneration // 本代标识：异步 reveal 时校验，过期则放弃显示

  // 先彻底清理上一次的窗口与拖拽状态，避免任何残留
  destroyOverlay()
  log.info('遮罩：已清理旧窗口，新建 ' + cap.displays.length + ' 个窗口')

  for (let i = 0; i < cap.displays.length; i++) {
    const d = cap.displays[i]
    const win = new BrowserWindow({
      frame: false,
      // 不透明窗口：遮罩页本就铺满全屏截图，不需要透出桌面。
      // 软件渲染（默认兼容模式）下透明窗口合成容易异常 → 表现为「窗口存在但完全看不见」，
      // 改不透明可彻底规避，同时显著降低合成开销（拖拽更顺）。
      transparent: false,
      backgroundColor: '#202531',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false, // 先隐藏，等截图数据推入后再显示，避免闪白
      x: d.physX,
      y: d.physY,
      width: d.pxWidth,
      height: d.pxHeight,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver') // 盖在全屏应用之上
    // 构造时窗口可能被收缩到 workArea（丢任务栏），此处显式恢复为整屏物理边界
    win.setBounds({ x: d.physX, y: d.physY, width: d.pxWidth, height: d.pxHeight }, false)
    win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'))

    // 诊断：加载/渲染失败必须留痕，否则表现为「遮罩窗口透明不可见、像没反应」
    win.webContents.on('did-fail-load', (_ev, code, desc, url) => {
      log.error('遮罩页加载失败: code=' + code + ' ' + desc + ' url=' + url)
    })
    win.webContents.on('render-process-gone', (_ev, det) => {
      log.error('遮罩渲染进程退出: reason=' + det.reason + ' exitCode=' + det.exitCode)
    })
    win.once('ready-to-show', () => log.info('遮罩窗口 ready-to-show idx=' + i))

    // 关闭即销毁（不再隐藏复用），并清空相关状态
    win.on('closed', () => {
      overlayWins = overlayWins.filter((w) => w !== win)
      if (overlayWins.length === 0) {
        stopDragPolling()
        drag = null
        overlayLayoutKey = ''
      }
    })
    overlayWins.push(win)
  }
  overlayLayoutKey = currentLayoutKey(cap)

  // 推数据并显示
  for (let i = 0; i < cap.displays.length; i++) {
    const win = overlayWins[i]
    if (!win || win.isDestroyed()) continue

    const payload = { displays: cap.displays, physVirtual: cap.physVirtual, myIndex: i }
    const reveal = () => {
      if (win.isDestroyed() || myGen !== overlayGeneration) return // 已被关闭或新截图取代
      win.webContents.send('overlay:screens', payload)
      win.show()
      win.focus()
      log.info('遮罩 reveal idx=' + i + ' visible=' + win.isVisible() +
        ' bounds=' + JSON.stringify(win.getBounds()))
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal)
    else reveal()
  }
}

// 关闭遮罩：直接销毁窗口并清空全部状态（不再隐藏复用，避免残留到下一次截屏）
function closeOverlay() {
  overlayGeneration++ // 让未完成的 reveal 过期，避免关闭后又被异步 show 回来
  log.info('关闭遮罩：销毁窗口并清理状态')
  destroyOverlay()
}

// 打开结果窗口
function showResultWindow() {
  if (resultWin) { resultWin.focus(); return }
  resultWin = new BrowserWindow({
    width: 720,
    height: 560,
    title: '识别结果',
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  resultWin.loadFile(path.join(__dirname, '..', 'renderer', 'result.html'))
  resultWin.webContents.once('did-finish-load', () => {
    // force-device-scale-factor=1 让结果页在高 DPI 屏上偏小，按系统 DPI 缩放补偿回正常大小
    resultWin.webContents.setZoomFactor(getSystemScaleFactor())
    resultWin.focus()
  })
  resultWin.on('closed', () => { resultWin = null })
}

// 打开设置窗口
function showSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 540,
    height: 640,
    minWidth: 440,
    minHeight: 520,
    title: '设置 — 截屏 OCR',
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'))
  settingsWin.webContents.once('did-finish-load', () => {
    // force-device-scale-factor=1 下按系统 DPI 缩放补偿，保证设置页在高 DPI 屏清晰可读
    settingsWin.webContents.setZoomFactor(getSystemScaleFactor())
  })
  settingsWin.on('closed', () => { settingsWin = null })
}

// 读取 Windows 系统缩放（主屏 DPI），用于结果页缩放补偿。
// 因 force-device-scale-factor=1 后 screen.scaleFactor 恒为 1，改从注册表取原始值。
let cachedScale = null
function getSystemScaleFactor() {
  if (cachedScale) return cachedScale
  try {
    const { execSync } = require('child_process')
    const out = execSync(
      'powershell -NoProfile -Command "(Get-ItemProperty \'HKCU:\\Control Panel\\Desktop\\WindowMetrics\').AppliedDPI"',
      { encoding: 'utf8', timeout: 3000 }
    )
    const dpi = parseInt(out.trim(), 10)
    cachedScale = dpi >= 96 ? dpi / 96 : 1
  } catch {
    cachedScale = 1
  }
  return cachedScale
}

// 触发一次截屏：捕获所有屏 → 打开遮罩（每屏一窗，每次全新创建）
// 说明：不做「先显示复用窗口」的优化——那会把上一次的截图画面带到本次，造成界面叠加。
async function onCapture() {
  if (anyOverlayVisible()) {
    log.info('onCapture: 遮罩已可见，忽略重复触发')
    return
  }
  const t0 = Date.now()
  log.info('onCapture 开始')
  try {
    const cap = await captureAllScreens()
    log.info('捕获完成: ' + cap.displays.length + ' 屏 +' + (Date.now() - t0) + 'ms | ' +
      cap.displays.map((d) => d.pxWidth + 'x' + d.pxHeight + '@' + (d.dataUrl || '').length + 'B').join(', '))
    showOverlay(cap)
    log.info('遮罩显示完成 +' + (Date.now() - t0) + 'ms')
  } catch (e) {
    log.error('截图失败: ' + (e && e.stack ? e.stack : e))
  }
}

// IPC：拖拽开始 —— 记录起点（全局物理坐标）并开始轮询
ipcMain.handle('overlay:dragStart', () => {
  const p = screen.getCursorScreenPoint()
  drag = { startX: p.x, startY: p.y, curX: p.x, curY: p.y }
  startDragPolling()
  broadcast('overlay:sync', { drag })
})

// IPC：拖拽结束 —— 停止轮询，返回最终全局物理选区矩形
ipcMain.handle('overlay:dragEnd', () => {
  stopDragPolling()
  const p = screen.getCursorScreenPoint()
  const sx = drag ? drag.startX : p.x
  const sy = drag ? drag.startY : p.y
  const rect = {
    x: Math.min(sx, p.x),
    y: Math.min(sy, p.y),
    width: Math.abs(p.x - sx),
    height: Math.abs(p.y - sy)
  }
  broadcast('overlay:sync', { drag: null }) // 通知所有窗口清空选区
  drag = null
  return rect
})

// IPC：渲染进程已裁好选区（PNG dataURL）→ 交给 OCR
ipcMain.handle('capture:region', async (_e, dataUrl) => {
  const b64 = String(dataUrl).split(',')[1]
  if (!b64) throw new Error('选区数据为空')
  const buf = Buffer.from(b64, 'base64')
  const t0 = Date.now()
  const res = await ocr.recognize(buf)
  log.info('OCR 完成: ' + (res.texts || []).length + ' 行 | 引擎耗时 ' +
    (res.elapse_ms != null ? res.elapse_ms + 'ms' : '?') + ' | 端到端 ' + (Date.now() - t0) +
    'ms | 档位 ' + (res.profile || ocr.profile))
  return res
})

// IPC：遮罩页识别完成后，把结果交给主进程并打开/刷新结果窗口
ipcMain.handle('show:result', (_e, payload) => {
  resultData = payload
  if (resultWin) {
    // 结果窗口已存在：推送新结果并聚焦（支持连续截图）
    resultWin.webContents.send('result:update', payload)
    resultWin.focus()
  } else {
    showResultWindow()
  }
})

// IPC：结果窗口加载后拉取结果数据
ipcMain.handle('result:get', () => resultData)

// IPC：写剪贴板
ipcMain.handle('clipboard:copy', (_e, text) => copyText(text))

// IPC：关闭遮罩（Esc / 识别完成）
ipcMain.handle('overlay:close', () => { closeOverlay() })

// IPC：关闭结果窗口（Esc / 复制后自动关闭）
ipcMain.handle('result:close', () => { if (resultWin) resultWin.close() })

// IPC：读取配置
ipcMain.handle('settings:get', () => getAll())

// IPC：保存配置
ipcMain.handle('settings:set', (_e, partial) => {
  try {
    const old = getAll()
    const shortcutChanged = partial.shortcut && partial.shortcut !== old.shortcut

    // 应用快捷键（失败则回滚旧快捷键并报错）
    if (shortcutChanged) {
      const r = updateShortcut({ onCapture, onQuit: () => app.quit() }, partial.shortcut)
      if (!r.ok) return { ok: false, error: '该快捷键被其他程序占用，请换一个组合' }
    }

    // 应用开机自启
    if (typeof partial.autoLaunch === 'boolean' && partial.autoLaunch !== old.autoLaunch) {
      app.setLoginItemSettings({ openAtLogin: partial.autoLaunch })
    }

    // 写入配置
    update(partial)

    // 应用 OCR 档位（运行时切换，无需重启）
    if (partial.ocrProfile && partial.ocrProfile !== old.ocrProfile) {
      ocr.setProfile(partial.ocrProfile).then((ok) => {
        log.info('OCR 档位切换 -> ' + partial.ocrProfile + '：' + (ok ? '成功' : '失败'))
      })
    }

    // 刷新托盘菜单/提示中的快捷键文本
    if (shortcutChanged && tray && tray.refresh) tray.refresh()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// IPC：关闭设置窗口
ipcMain.handle('settings:close', () => { if (settingsWin) settingsWin.close() })

// IPC：打开设置窗口
ipcMain.handle('settings:open', () => { showSettingsWindow() })

// IPC：手动检查更新
ipcMain.handle('update:check', () => { checkForUpdates() })

// IPC：获取应用版本号
ipcMain.handle('app:version', () => app.getVersion())

app.whenReady().then(() => {
  if (!gotLock) { log.info('非主实例，退出'); return } // 非主实例：应用正在退出，不注册任何资源
  log.info('whenReady: 主实例已获得锁')
  registerShortcuts({ onCapture, onQuit: () => app.quit() })
  tray = createTray({ onCapture, onQuit: () => app.quit(), onSettings: showSettingsWindow })

  // 自动更新：状态推送给设置窗口
  setupUpdater({
    onStatus: (status) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:status', status)
    }
  })

  // 同步开机自启状态到系统
  const cfg = getAll()
  app.setLoginItemSettings({ openAtLogin: !!cfg.autoLaunch })

  // 预热 OCR 模型，避免首次截图卡顿
  ocr.init().catch((e) => log.error('OCR 初始化失败: ' + (e && e.message)))

  // 启动后**不自动截屏**：必须由用户主动触发（快捷键 / 托盘菜单 / 再次双击图标）。
  // 仅当用户在设置里显式开启「启动时立即截屏」时才自动弹遮罩。
  const autoCapture = cfg.captureOnLaunch === true
  log.info('captureOnLaunch=' + autoCapture + '（默认 false，需用户主动触发）')
  if (autoCapture) onCapture()

  // 启动时自动检查更新（延迟几秒，避免与截图遮罩/OCR 预热抢占资源）
  if (cfg.autoCheckUpdate !== false && app.isPackaged) {
    setTimeout(() => checkForUpdates(), 3000)
  }
})

app.on('window-all-closed', () => {
  // 有托盘常驻，不随窗口关闭退出；仅 macOS 之外保持默认
})

app.on('before-quit', () => { isQuitting = true })

app.on('will-quit', () => {
  unregisterAll()
  ocr.close()
})
