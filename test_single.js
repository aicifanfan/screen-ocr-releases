// 单实例锁测试：第二实例应立即退出，主实例收到 second-instance 并唤起遮罩
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

process.env.SCREEN_OCR_PYTHON =
  'C:/Users/Lenovo/.workbuddy/binaries/python/envs/ocr/Scripts/python.exe'

// 对齐 userData 与安装版（npx electron 直接跑脚本的默认 userData 是 "Electron"，
// 与 electron . 的 "screen-ocr" 不同会导致单实例锁文件不同、测试失真）
app.setPath('userData', require('path').join(app.getPath('appData'), 'screen-ocr'))

require('./src/main/index.js') // 本进程 = 主实例

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  try {
    await sleep(1200)
    // 启动第二实例（electron + 主入口），应被单实例锁立即终止
    const child = spawn(process.execPath, ['--no-sandbox', '--disable-gpu', '--in-process-gpu', '.'],
      { cwd: path.join(__dirname), env: { ...process.env } })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    let exited = false, code = null
    child.on('exit', (c) => { exited = true; code = c })
    for (let i = 0; i < 80 && !exited; i++) await sleep(100)
    console.log('[OK] 第二实例退出:', exited, 'code:', code, '(单实例锁生效)')
    if (!exited && out) console.log('[第二实例输出]', out.slice(0, 500))

    // 主实例遮罩应被 second-instance → onCapture 唤起
    let overlay = null
    for (let i = 0; i < 50 && !overlay; i++) {
      await sleep(200)
      overlay = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay'))
    }
    console.log('[OK] 主实例遮罩被唤起:', !!overlay)

    // 遮罩页屏 canvas 存在性（顺带回归：多窗口遮罩，每窗合成全部屏）
    let barOk = false
    if (overlay) {
      const n = await overlay.webContents.executeJavaScript(
        `document.querySelectorAll('#screens canvas').length`)
      barOk = n >= 1
      console.log('[OK] 遮罩页屏 canvas 数:', n)
    }
    const ok = exited && !!overlay && barOk
    console.log(ok ? '[PASS] 单实例锁 + 二次启动唤起截屏' : '[FAIL] 单实例锁行为异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 200)
  }
})
