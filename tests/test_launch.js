// Step 3 启动自检：验证 Electron 主进程各模块在 Electron 环境下可正常加载
const { app } = require('electron')

const modules = [
  '../src/main/screen-capture',
  '../src/main/ocr-bridge',
  '../src/main/shortcut',
  '../src/main/tray',
  '../src/main/clipboard'
]

app.whenReady().then(() => {
  try {
    for (const m of modules) {
      require(m)
      console.log('[OK] 模块加载:', m)
    }
    console.log('[PASS] Electron 启动与模块加载正常')
  } catch (e) {
    console.error('[FAIL] 模块加载失败:', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
