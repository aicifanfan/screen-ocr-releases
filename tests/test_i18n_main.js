// 主进程语言链路集成测试（真实 index.js + 真实 preload + 真实设置窗口）
// ① 配置 language=en 时，主进程创建的窗口里 preload 拿到的 initialLanguage 就是 en，
//    且设置页首屏直接渲染成英文（无需刷新）
// ② 渲染进程调用 setLanguage('zh') 后：配置持久化 + 收到 i18n:changed 广播
// ③ 非法设置值按 auto 回落
//
// 运行：npx electron test_i18n_main.js --no-sandbox
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

// 独立 userData：不污染真实配置，也不与安装版抢单实例锁
const USER_DATA = path.join(app.getPath('appData'), 'screen-ocr-test-i18n')
app.setPath('userData', USER_DATA)

// 预置英文配置（index.js 在 require 时就会读取）
fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  shortcut: 'CommandOrControl+Shift+A',
  autoLaunch: false,
  captureOnLaunch: false,
  autoCloseAfterCopy: true,
  autoCheckUpdate: false,
  ocrProfile: 'balanced',
  disableGpu: true,
  language: 'en',
  __v: 2
}, null, 2), 'utf8')

process.env.SCREEN_OCR_PYTHON = 'C:/Users/Lenovo/.workbuddy/binaries/python/envs/ocr/Scripts/python.exe'
require('../src/main/index.js')

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, cond, detail) {
  if (cond) console.log('  [OK]   ' + name)
  else { failed++; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')) }
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8')) } catch { return {} }
}

const settingsWindows = () => BrowserWindow.getAllWindows()
  .filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('settings.html'))

app.whenReady().then(async () => {
  try {
    await sleep(800) // 等 index.js 完成初始化（托盘、快捷键、OCR 预热）

    // 用一个“驱动窗口”调用真实 IPC，让主进程自己创建设置窗口
    const driver = new BrowserWindow({
      show: false, width: 300, height: 200,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
    })
    await driver.loadURL('data:text/html,<html><body>driver</body></html>')
    await driver.webContents.executeJavaScript('window.api.openSettings()')

    let wins = []
    for (let i = 0; i < 50 && !wins.length; i++) { await sleep(100); wins = settingsWindows() }
    if (!wins.length) throw new Error('设置窗口未创建')
    const settingsWin = wins[0]
    for (let i = 0; i < 50 && settingsWin.webContents.isLoading(); i++) await sleep(100)
    await sleep(300)

    console.log('\n== 启动语言（配置 en → 真实设置窗口）==')
    const initial = await settingsWin.webContents.executeJavaScript('window.api.initialLanguage')
    check('preload initialLanguage = en', initial === 'en', String(initial))
    const title = await settingsWin.webContents.executeJavaScript(
      `document.querySelector('.header h1').textContent`)
    check('设置页首屏直接是英文（无需切换）', title === 'Screen OCR Settings', title)
    check('窗口标题为英文', settingsWin.getTitle() === 'Settings — Screen OCR', settingsWin.getTitle())

    // ② 切到中文
    console.log('\n== 运行时切换 ==')
    await settingsWin.webContents.executeJavaScript(`
      window.__changed = null;
      window.api.onLanguageChanged((p) => { window.__changed = p; });
      true
    `)
    const res = await settingsWin.webContents.executeJavaScript(`window.api.setLanguage('zh')`)
    check('setLanguage 返回 ok', !!(res && res.ok), JSON.stringify(res))
    check('返回解析后的语言 zh', res && res.lang === 'zh', JSON.stringify(res))
    await sleep(400)

    const changed = await settingsWin.webContents.executeJavaScript('window.__changed')
    check('收到 i18n:changed 广播', !!(changed && changed.lang === 'zh'), JSON.stringify(changed))
    const htmlAfter = await settingsWin.webContents.executeJavaScript(
      `document.querySelector('.header h1').textContent`)
    check('设置页就地切回中文', htmlAfter === '截屏 OCR 设置', htmlAfter)
    check('窗口标题同步为中文', settingsWin.getTitle() === '设置 — 截屏 OCR', settingsWin.getTitle())
    check('语言已持久化到 settings.json', readConfig().language === 'zh', JSON.stringify(readConfig().language))

    // ③ 非法值回落
    console.log('\n== 非法设置值回退 ==')
    const bad = await settingsWin.webContents.executeJavaScript(`window.api.setLanguage('klingon')`)
    check('非法值按 auto 处理', bad && bad.setting === 'auto', JSON.stringify(bad))
    check('非法值解析为系统/默认语言', bad && (bad.lang === 'zh' || bad.lang === 'en'), JSON.stringify(bad))

    // 清回 auto，避免影响下一次运行
    await settingsWin.webContents.executeJavaScript(`window.api.setLanguage('auto')`)
    await sleep(200)
    check('恢复 auto 已写入配置', readConfig().language === 'auto', JSON.stringify(readConfig().language))

    console.log('\n' + (failed === 0 ? '[ALL PASS] 主进程语言链路正确' : '[FAIL] 共 ' + failed + ' 项失败'))
    if (failed !== 0) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL] 测试异常:', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 300)
  }
})
