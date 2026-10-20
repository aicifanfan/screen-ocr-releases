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
const I18n = require('../shared/i18n')
const log = require('./log')
const fs = require('fs')
const { execFile } = require('child_process')

log.init()

// —— 界面语言 ——
// 规则：config.language = auto | zh | en（非法值按 auto）
//   auto → 跟随系统语言 → 仍无法识别则回退 zh
// 切换后立刻广播给所有窗口，渲染进程就地重绘，无需刷新页面。
let langSetting = 'auto'
let currentLang = I18n.DEFAULT_LANG

function detectSystemLang() {
  try {
    return app.getSystemLocale() || app.getLocale() || I18n.DEFAULT_LANG
  } catch {
    return I18n.DEFAULT_LANG
  }
}

function initLanguage() {
  try { langSetting = I18n.normalizeSetting(getAll().language) } catch { langSetting = 'auto' }
  currentLang = I18n.resolveLang(langSetting, detectSystemLang())
  log.info('UI language: setting=' + langSetting + ' resolved=' + currentLang +
    ' system=' + detectSystemLang())
}

// 主进程内取译文
function t(key, params) { return I18n.t(currentLang, key, params) }

initLanguage()

// 广播语言变更：所有窗口重绘 + 托盘菜单重建 + 窗口标题更新
function broadcastLanguage() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('i18n:changed', { lang: currentLang, setting: langSetting })
  }
  if (tray && tray.refresh) tray.refresh()
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(t('settings.title'))
  if (resultWin && !resultWin.isDestroyed()) resultWin.setTitle(t('result.title'))
}

// 渲染进程初始语言通过窗口的 additionalArguments（--app-lang=xx）注入，
// 不再使用 sendSync：同步 IPC 在无监听者时会干扰页面导航，且会阻塞渲染线程。

// 设置页切换语言：立即持久化 + 广播（不依赖「保存」按钮）
ipcMain.handle('i18n:set', (_e, language) => {
  try {
    langSetting = I18n.normalizeSetting(language)
    currentLang = I18n.resolveLang(langSetting, detectSystemLang())
    update({ language: langSetting })
    log.info('UI language changed -> ' + langSetting + ' (resolved: ' + currentLang + ')')
    broadcastLanguage()
    return { ok: true, lang: currentLang, setting: langSetting }
  } catch (e) {
    return { ok: false, lang: currentLang, setting: langSetting, error: e.message }
  }
})

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
let gpuReason = 'default compatibility mode'
let crashedBefore = false
try {
  const cfg = getAll()
  crashedBefore = gpuCrashedBefore()
  if (crashedBefore) {
    gpuOff = true
    gpuReason = 'previous child-process crash, auto downgraded'
  } else if (cfg.disableGpu === false) {
    gpuOff = false
    gpuReason = 'user enabled GPU acceleration'
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

log.info('GPU acceleration: ' + (gpuOff || isRdpSession ? 'off' : 'on') +
  ' | reason=' + (isRdpSession ? 'remote desktop session' : gpuReason) +
  ' | rdp=' + isRdpSession + ' | crashFallback(no-sandbox)=' + crashedBefore)

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
const pendingRefined = new Map() // seq -> 精修结果（show:result 还没到就先存着）

// 两段式渐进：把精修结果合并进最近一次结果（实现见 ./refined.js，纯函数便于单测）。
const { applyRefined } = require('./refined')

// 精修结果由 sidecar 异步推送：更新缓存并刷新窗口。
// 注意：这个赋值必须放在 `const ocr = new OcrBridge(...)` **之后**，
// 否则模块加载阶段就会踩 TDZ（Cannot access 'ocr' before initialization），
// 整个主进程直接挂掉、双击无反应（0.3.0 的真实事故）。
function bindRefinedHandler() {
  ocr.onRefined = (msg) => {
    if (!msg || msg.seq == null) return
    if (!resultData) {
      pendingRefined.set(msg.seq, msg)
      return
    }
    const ok = applyRefined(resultData, msg)
    if (!ok) {
      pendingRefined.set(msg.seq, msg)
      return
    }
    // 流式精修会推很多条，只有最后一条值得写日志（否则日志被刷屏）
    if (msg.final !== false) {
      log.info('OCR 精修完成: ' + (msg.lines || 0) + ' 行 | 精修耗时 ' + (msg.refine_ms || '?') +
        'ms | 端到端 ' + (msg.elapse_ms || '?') + 'ms')
    }
    if (resultWin && !resultWin.isDestroyed() && resultWinReady) {
      resultWin.webContents.send('result:update', resultData)
    }
  }
}
// OCR 档位来自配置（默认 balanced：实测比默认参数快 9.4x，CER 从 9.09% 降到 2.16%）
let ocrProfile = 'balanced'
try { ocrProfile = getAll().ocrProfile || 'balanced' } catch { /* 配置不可读用默认 */ }
const ocr = new OcrBridge(ocrProfile)
bindRefinedHandler() // 必须在 ocr 初始化之后绑定（见函数上的注释）

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
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=' + currentLang] }
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
// 说明：窗口默认隐藏创建，等页面「首屏可绘制」（ready-to-show）再显示：
//   1) 避免加载期的白屏闪烁；
//   2) OCR 进行中就可以先把窗口建好（见 capture:region），结果一到直接显示，
//      不再让用户多等一次页面加载（实测 ~560ms）。
let resultWinReady = false     // 页面是否已完成加载
let resultPending = false      // OCR 是否仍在进行（结果为 null 时区分「还没来」与「确实没有」）
let showResultOnReady = false  // 数据先到、页面还没加载完：加载完成后自动显示

function createResultWindow() {
  resultWin = new BrowserWindow({
    width: 720,
    height: 560,
    title: t('result.title'),
    show: false,
    backgroundColor: '#f8fafc', // 与页面底色一致，消除启动瞬间的白块
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=' + currentLang] }
  })
  resultWinReady = false
  resultWin.loadFile(path.join(__dirname, '..', 'renderer', 'result.html'))
  // 加载失败 / 渲染进程崩溃必须留痕，否则表现为「识别完成但没有窗口」
  resultWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log.error('结果页加载失败: code=' + code + ' ' + desc + ' url=' + url)
  })
  resultWin.webContents.on('render-process-gone', (_e, det) => {
    log.error('结果页渲染进程退出: reason=' + det.reason + ' exitCode=' + det.exitCode)
  })
  resultWin.once('ready-to-show', () => {
    resultWinReady = true
    applyZoom(resultWin)
    if (showResultOnReady && resultWin && !resultWin.isDestroyed()) {
      showResultOnReady = false
      resultWin.show()
      resultWin.focus()
    }
  })
  resultWin.on('closed', () => {
    resultWin = null
    resultWinReady = false
    showResultOnReady = false
  })
  return resultWin
}

// OCR 开始时预建窗口：把页面加载摊到识别耗时里，结果到达即显示。
// 失败重试不影响：窗口只是隐藏着，不会打扰用户。
function preloadResultWindow() {
  if (resultWin && !resultWin.isDestroyed()) return
  resultPending = true
  createResultWindow()
  log.info('结果窗口预加载（OCR 进行中）')
}

function openResultWindow() {
  if (!resultWin || resultWin.isDestroyed()) createResultWindow()
  if (resultWinReady) {
    applyZoom(resultWin)
    resultWin.show()
    resultWin.focus()
    return
  }
  showResultOnReady = true
}

// 打开设置窗口
function showSettingsWindow() {
  if (settingsWin) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 540,
    height: 640,
    minWidth: 440,
    minHeight: 520,
    title: t('settings.title'),
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=' + currentLang] }
  })
  settingsWin.setMenuBarVisibility(false)
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'))
  settingsWin.webContents.once('did-finish-load', () => {
    // force-device-scale-factor=1 下按系统 DPI 缩放补偿，保证设置页在高 DPI 屏清晰可读
    // （异步读取，避免 PowerShell 阻塞主进程）
    applyZoom(settingsWin)
  })
  settingsWin.on('closed', () => { settingsWin = null })
}

// 读取 Windows 系统缩放（主屏 DPI），用于结果页 / 设置页缩放补偿。
// 因 force-device-scale-factor=1 后 screen.scaleFactor 恒为 1，改从注册表取原始值。
//
// 必须异步：execSync 调 PowerShell 实测 ~1.0s，且整段阻塞主进程；
// 而这一刻渲染进程正在等 settings:get / result:get，表现为「窗口出来了，内容半天不来」。
// 改为异步 + 启动预热：窗口打开时通常已有缓存，取不到就等 Promise，不再卡事件循环。
let cachedScale = null
let scalePromise = null

function readSystemScale() {
  if (cachedScale) return Promise.resolve(cachedScale)
  if (scalePromise) return scalePromise

  scalePromise = new Promise((resolve) => {
    const done = (v) => {
      cachedScale = v
      scalePromise = null
      resolve(v)
    }
    try {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop\\WindowMetrics').AppliedDPI"],
        { encoding: 'utf8', timeout: 2500, windowsHide: true },
        (err, stdout) => {
          if (err) return done(1)
          const dpi = parseInt(String(stdout || '').trim(), 10)
          // 合理区间 96(100%) ~ 288(300%)；异常值一律按 100%，避免把窗口放大到不可用
          done(Number.isFinite(dpi) && dpi >= 96 && dpi <= 288 ? dpi / 96 : 1)
        }
      )
    } catch {
      done(1)
    }
  })
  return scalePromise
}

// 应用缩放：有缓存立即生效；没有则异步补上（不影响窗口先显示）
function applyZoom(win) {
  if (!win || win.isDestroyed()) return
  readSystemScale()
    .then((scale) => {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.setZoomFactor(scale)
      }
    })
    .catch(() => { /* 缩放补偿失败不影响主流程 */ })
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

// IPC：渲染进程已裁好选区（图片 dataURL）→ 交给 OCR
// 优化点：
//   1) 不再 decode 成 Buffer 再 base64 —— 直接把 base64 透传给 sidecar，省两次整块拷贝；
//   2) 进 OCR 前先把结果窗口预建好（隐藏），页面加载与识别并行，结果到达即可显示；
//   3) 入口处做格式/体积校验，异常输入直接给错误码，不让坏数据进 Python。
const MAX_IMAGE_BASE64 = 24 * 1024 * 1024 // ≈18MB 二进制，远超任何正常选区

ipcMain.handle('capture:region', async (_e, dataUrl) => {
  const raw = typeof dataUrl === 'string' ? dataUrl : ''
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(raw)
  if (!m) throw new Error('E_EMPTY_SELECTION') // 渲染层按错误码翻译，避免硬编码文案
  const b64 = m[2].replace(/\s+/g, '')
  if (!b64) throw new Error('E_EMPTY_SELECTION')
  if (b64.length > MAX_IMAGE_BASE64) throw new Error('E_IMAGE_TOO_LARGE')

  const t0 = Date.now()
  preloadResultWindow() // 与 OCR 并行加载结果页
  try {
    const res = await ocr.recognizeBase64(b64)
    resultPending = false
    log.info('OCR 完成: ' + (res.texts || []).length + ' 行 | 引擎耗时 ' +
      (res.elapse_ms != null ? res.elapse_ms + 'ms' : '?') + ' | 端到端 ' + (Date.now() - t0) +
      'ms | 档位 ' + (res.profile || ocr.profile))
    return res
  } catch (e) {
    resultPending = false
    log.error('OCR 失败: ' + (e && e.message ? e.message : e))
    throw e
  }
})

// IPC：遮罩页识别完成后，把结果交给主进程并打开/刷新结果窗口
ipcMain.handle('show:result', (_e, payload) => {
  const valid = payload && Array.isArray(payload.screens) && payload.screens.length > 0
  if (!valid) {
    resultPending = false
    log.warn('show:result 收到空结果，忽略')
    return { ok: false, reason: 'EMPTY' }
  }
  // 两段式渐进：临时结果先上屏，最终结果稍后由 result:refined 推过来
  const first = payload.screens[0] || {}
  payload.provisional = first.stage === 'provisional'
  payload.refined = !payload.provisional
  // 新一次截图：必须把上一次遗留的「精修中」状态清掉，
  // 否则切到均衡（根本没有精修）时，结果页可能还挂着上一次高精度的提示。
  payload.refiningDone = !payload.provisional
  payload.refineProgress = null
  payload.newResult = true // 渲染层据此判断「这是新截图，不是精修替换」，不要延后应用
  resultData = payload
  resultPending = false

  // 精修结果比 show:result 先到（极少数时序）：这里补上，避免永远停在「精修中」
  const early = pendingRefined.get(first.seq)
  if (early) {
    pendingRefined.delete(first.seq)
    applyRefined(payload, early)
  }

  if (resultWin && !resultWin.isDestroyed()) {
    // 预加载窗口：直接推数据（页面可能还在加载，加载完会自己 getResult 再渲染）
    if (resultWinReady) resultWin.webContents.send('result:update', payload)
    openResultWindow()
  } else {
    createResultWindow()
    openResultWindow()
  }
  return { ok: true }
})

// IPC：结果窗口加载后拉取结果数据
// resultPending 时返回 pending 标记：页面保持骨架屏，而不是误判成「没识别到文字」
ipcMain.handle('result:get', () => (resultPending ? { pending: true } : resultData))

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
    // 快照旧值：后面 update() 可能会换掉缓存对象，直接持有引用会让「是否变化」判断失效
    const old = { ...getAll() }
    const shortcutChanged = partial.shortcut && partial.shortcut !== old.shortcut

    // 应用快捷键（失败则回滚旧快捷键并报错）
    if (shortcutChanged) {
      const r = updateShortcut({ onCapture, onQuit: () => app.quit() }, partial.shortcut)
      // 返回错误码，渲染层按当前语言翻译；error 字段保留给未知调用方兜底
      if (!r.ok) return { ok: false, errorCode: 'shortcutOccupied', error: t('settings.shortcutOccupied') }
    }

    // 应用开机自启
    if (typeof partial.autoLaunch === 'boolean' && partial.autoLaunch !== old.autoLaunch) {
      app.setLoginItemSettings({ openAtLogin: partial.autoLaunch })
    }

    // 应用 OCR 档位（运行时切换，无需重启）
    // 必须在写配置之前判断：写配置会改变缓存，之后再比就永远相等了（历史 bug）
    if (partial.ocrProfile && partial.ocrProfile !== old.ocrProfile) {
      ocr.setProfile(partial.ocrProfile)
        .then((ok) => {
          log.info('OCR 档位切换 -> ' + partial.ocrProfile + '：' +
            (ok ? '成功' : '失败（引擎未确认，仍为 ' + ocr.profile + '）'))
        })
        .catch((e) => log.error('OCR 档位切换异常: ' + (e && e.message)))
    }

    // 写入配置
    update(partial)

    // 刷新托盘菜单/提示中的快捷键文本
    if (shortcutChanged && tray && tray.refresh) tray.refresh()
    return { ok: true }
  } catch (e) {
    return { ok: false, errorCode: 'unknown', error: e.message }
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
  tray = createTray({
    onCapture,
    onQuit: () => app.quit(),
    onSettings: showSettingsWindow,
    getLang: () => currentLang
  })

  // 自动更新：状态推送给设置窗口；译文随当前语言
  setupUpdater({
    onStatus: (status) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:status', status)
    },
    t
  })

  // 同步开机自启状态到系统
  const cfg = getAll()
  app.setLoginItemSettings({ openAtLogin: !!cfg.autoLaunch })

  // 预热 OCR 模型，避免首次截图卡顿
  ocr.init()
    .then(() => log.info('OCR 就绪：实际档位 ' + ocr.profile))
    .catch((e) => log.error('OCR 初始化失败: ' + (e && e.message)))

  // 预热系统缩放读取：把 ~1s 的外部进程调用挪到启动阶段（异步，不阻塞窗口）
  readSystemScale()
    .then((s) => log.info('系统缩放 = ' + s + 'x'))
    .catch(() => {})

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
