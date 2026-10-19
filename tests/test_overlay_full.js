// 完整启动主进程，诊断「每块屏一个遮罩窗口」是否覆盖全部屏（关键回归：主屏必须被覆盖）
// 运行（真机）：npx electron test_overlay_full.js
const { app, BrowserWindow, screen } = require('electron')

// 让 OCR sidecar 用 ocr venv 启动（若本机无 OCR 依赖）
process.env.SCREEN_OCR_PYTHON =
  'C:/Users/Lenovo/.workbuddy/binaries/python/envs/ocr/Scripts/python.exe'

require('../src/main/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    // 启动后不再自动截屏 → 显式触发一次（等价于用户按快捷键 / 再次双击图标）
    app.emit('second-instance')

    // 等 onCapture 完成：为每块屏创建一个遮罩窗口
    let overlays = []
    for (let i = 0; i < 60 && overlays.length === 0; i++) {
      await sleep(200)
      overlays = BrowserWindow.getAllWindows().filter((w) =>
        w.webContents.getURL().includes('overlay'))
    }
    if (!overlays.length) { console.log('[FAIL] 遮罩窗口未出现'); app.quit(); return }

    const displays = screen.getAllDisplays()
    console.log('屏幕数:', displays.length, ' | 遮罩窗口数:', overlays.length)

    // 每块屏必须被某个遮罩窗口完整覆盖
    let allCovered = true
    for (const d of displays) {
      const b = d.bounds
      const covered = overlays.some((w) => {
        const wb = w.getBounds()
        return (
          wb.x <= b.x && wb.y <= b.y &&
          wb.x + wb.width >= b.x + b.width &&
          wb.y + wb.height >= b.y + b.height
        )
      })
      if (!covered) allCovered = false
      console.log(
        (covered ? '[PASS]' : '[FAIL]') +
        ' 屏 ' + JSON.stringify(b) + ' 被遮罩覆盖'
      )
    }

    // 关键回归：主屏必须被覆盖（历史 bug：遮罩只盖副屏、漏掉主屏）
    const primary = screen.getPrimaryDisplay()
    const pb = primary.bounds
    const pCovered = overlays.some((w) => {
      const wb = w.getBounds()
      return (
        wb.x <= pb.x && wb.y <= pb.y &&
        wb.x + wb.width >= pb.x + pb.width &&
        wb.y + wb.height >= pb.y + pb.height
      )
    })
    console.log(pCovered ? '[PASS] 主屏已被遮罩覆盖（回归修复）' : '[FAIL] 主屏仍未被覆盖')

    // 遮罩窗口数应等于屏数
    const countOk = overlays.length === displays.length
    console.log(countOk ? '[PASS] 遮罩窗口数 = 屏数' : '[WARN] 遮罩窗口数与屏数不一致')

    const ok = allCovered && pCovered && countOk
    console.log(ok ? '[ALL PASS] 每块屏均被独立遮罩窗口覆盖' : '[FAIL] 存在未覆盖的屏')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 300)
  }
})
