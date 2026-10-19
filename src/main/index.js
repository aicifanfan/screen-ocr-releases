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

app.disableHardwareAcceleration() // 禁用 GPU：截屏/OCR 均为 CPU 工作，软件渲染更稳（兼容无 GPU/远程桌面环境）

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

let overlayWins = []  // 遮罩选区窗口（一块屏一个，覆盖整个虚拟桌面）
let resultWin = null  // 结果窗口
let settingsWin = null // 设置窗口
let tray = null
let resultData = null // 最近一次识别结果
const ocr = new OcrBridge()

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

// 打开遮罩选区窗口：每块屏一个，各覆盖本屏物理边界（无边框、透明、置顶）。
// 关键：跨屏超大窗口会被 Chromium 收缩到单屏工作区，故拆成「一块屏一个窗口」，
//       并在创建后 setBounds 纠正构造时被收缩到 workArea 的高度（保证盖满含任务栏）。
function showOverlay(cap) {
  closeOverlay()
  for (let i = 0; i < cap.displays.length; i++) {
    const d = cap.displays[i]
    const win = new BrowserWindow({
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
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
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('overlay:screens', {
        displays: cap.displays,
        physVirtual: cap.physVirtual,
        myIndex: i
      })
    })
    win.on('closed', () => {
      overlayWins = overlayWins.filter((w) => w !== win)
      if (overlayWins.length === 0) { stopDragPolling(); drag = null }
    })
    overlayWins.push(win)
  }
}

function closeOverlay() {
  stopDragPolling()
  drag = null
  for (const w of overlayWins) if (w && !w.isDestroyed()) w.close()
  overlayWins = []
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

// 触发一次截屏：捕获所有屏 → 打开遮罩（每屏一窗）
async function onCapture() {
  if (overlayWins.length > 0) return // 已在截图流程中，忽略重复触发
  try {
    const cap = await captureAllScreens()
    showOverlay(cap)
  } catch (e) {
    console.error('[capture] 截图失败：', e)
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
  return ocr.recognize(buf)
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
  if (!gotLock) return // 非主实例：应用正在退出，不注册任何资源
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
  ocr.init().catch((e) => console.error('[ocr] 初始化失败：', e.message))
  // 按设置决定是否「双击启动即弹出截屏遮罩」
  if (cfg.captureOnLaunch !== false) onCapture()

  // 启动时自动检查更新（延迟几秒，避免与截图遮罩/OCR 预热抢占资源）
  if (cfg.autoCheckUpdate !== false && app.isPackaged) {
    setTimeout(() => checkForUpdates(), 3000)
  }
})

app.on('window-all-closed', () => {
  // 有托盘常驻，不随窗口关闭退出；仅 macOS 之外保持默认
})

app.on('will-quit', () => {
  unregisterAll()
  ocr.close()
})
