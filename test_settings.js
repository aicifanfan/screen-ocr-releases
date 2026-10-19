// 设置页冒烟测试：DOM 加载 + 快捷键录制交互（无需真实截屏/OCR）
// 运行（真机/沙箱）：npx electron test_settings.js --no-sandbox
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, 'src', 'preload', 'index.js')
const SETTINGS = path.join(__dirname, 'src', 'renderer', 'settings.html')

// mock 主进程设置 IPC（测试进程不加载 index.js）
ipcMain.handle('settings:get', () => ({ shortcut: 'CommandOrControl+Shift+A', autoLaunch: false, captureOnLaunch: false, autoCloseAfterCopy: true, autoCheckUpdate: true, disableGpu: true, ocrProfile: 'balanced' }))
ipcMain.handle('settings:set', (_e, partial) => ({ ok: true, saved: partial }))
ipcMain.handle('settings:close', () => {})
ipcMain.handle('app:version', () => '0.1.0')
ipcMain.handle('update:check', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false, width: 460, height: 560,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
    })
    await win.loadFile(SETTINGS)

    // 等 init() 完成（默认快捷键已显示）
    let ready = false
    for (let i = 0; i < 50 && !ready; i++) {
      await sleep(100)
      ready = await win.webContents.executeJavaScript(
        `document.getElementById('hotkey-text').textContent === 'Ctrl + Shift + A'`)
    }
    console.log('[OK] 默认快捷键显示:', ready ? 'Ctrl + Shift + A' : '超时')

    // 关键元素存在性
    const dom = await win.webContents.executeJavaScript(`({
      hasHotkey: !!document.getElementById('hotkey-box'),
      hasAutoLaunch: !!document.getElementById('opt-autolaunch'),
      hasCaptureLaunch: !!document.getElementById('opt-capture-launch'),
      hasAutoClose: !!document.getElementById('opt-auto-close'),
      hasSave: !!document.getElementById('btn-save'),
      hasZoomIn: !!document.getElementById('zoom-in'),
      hasZoomOut: !!document.getElementById('zoom-out'),
      hasZoomReset: !!document.getElementById('zoom-reset'),
      hasZoomVal: !!document.getElementById('zoom-val'),
      hasVersion: !!document.getElementById('app-version'),
      hasCheckUpdate: !!document.getElementById('btn-check-update'),
      hasAutoCheck: !!document.getElementById('opt-auto-check'),
      hasUpdateStatus: !!document.getElementById('update-status'),
      hasGpuOpt: !!document.getElementById('opt-gpu'),
      hasOcrProfile: !!document.getElementById('opt-ocr-profile')
    })`)
    console.log('[OK] DOM 元素:', JSON.stringify(dom))

    // 模拟录制：点击 hotkey-box 进入录制 → 派发 Ctrl+Shift+B → 验证显示更新
    const recorded = await win.webContents.executeJavaScript(`(function(){
      document.getElementById('hotkey-box').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'b', ctrlKey:true, shiftKey:true, bubbles:true }));
      return {
        text: document.getElementById('hotkey-text').textContent,
        recording: document.getElementById('hotkey-box').classList.contains('recording')
      };
    })()`)
    console.log('[OK] 录制 Ctrl+Shift+B:', JSON.stringify(recorded), '(期望 text=Ctrl + Shift + B, recording=false)')

    // 录制中按 Esc → 取消录制并恢复原值（不应关闭窗口）
    const esc = await win.webContents.executeJavaScript(`(function(){
      document.getElementById('hotkey-box').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
      return {
        text: document.getElementById('hotkey-text').textContent,
        recording: document.getElementById('hotkey-box').classList.contains('recording')
      };
    })()`)
    console.log('[OK] 录制中 Esc 取消:', JSON.stringify(esc), '(期望 text=Ctrl + Shift + B, recording=false)')

    // 缩放：点两次放大 → 110% → 120%，再重置回 100%
    const zoom = await win.webContents.executeJavaScript(`(function(){
      document.getElementById('zoom-in').click();
      const f1 = window.api.getZoomFactor(), l1 = document.getElementById('zoom-val').textContent;
      document.getElementById('zoom-in').click();
      const f2 = window.api.getZoomFactor(), l2 = document.getElementById('zoom-val').textContent;
      document.getElementById('zoom-reset').click();
      const f3 = window.api.getZoomFactor(), l3 = document.getElementById('zoom-val').textContent;
      return { f1, l1, f2, l2, f3, l3 };
    })()`)
    console.log('[OK] 缩放:', JSON.stringify(zoom), '(期望 110%→120%→100%)')

    // 关于与更新：版本号显示 + 点击检查更新触发状态提示
    const update = await win.webContents.executeJavaScript(`(function(){
      const version = document.getElementById('app-version').textContent;
      document.getElementById('btn-check-update').click();
      return {
        version,
        statusText: document.getElementById('update-status').textContent,
        statusVisible: document.getElementById('update-status').style.display
      };
    })()`)
    console.log('[OK] 更新区块:', JSON.stringify(update), '(期望 version=v0.1.0, 状态=正在检查更新…)')

    const ok = ready && dom.hasHotkey && dom.hasAutoLaunch && dom.hasCaptureLaunch && dom.hasAutoClose && dom.hasSave &&
      dom.hasZoomIn && dom.hasZoomOut && dom.hasZoomReset && dom.hasZoomVal &&
      dom.hasVersion && dom.hasCheckUpdate && dom.hasAutoCheck && dom.hasUpdateStatus && dom.hasGpuOpt && dom.hasOcrProfile &&
      recorded.text === 'Ctrl + Shift + B' && recorded.recording === false &&
      esc.text === 'Ctrl + Shift + B' && esc.recording === false &&
      zoom.f1 > 1.05 && zoom.l1 === '110%' && zoom.f2 > 1.15 && zoom.l2 === '120%' &&
      zoom.f3 < 1.01 && zoom.l3 === '100%' &&
      update.version === 'v0.1.0' && update.statusText === '正在检查更新…' && update.statusVisible === 'block'
    console.log(ok ? '[PASS] 设置页加载 + 快捷键录制 + 界面缩放 + 更新区块正确' : '[FAIL] 设置页异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 200)
  }
})
