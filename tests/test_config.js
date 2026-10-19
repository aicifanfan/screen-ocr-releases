// 配置模块读写往返测试（用临时 userData，避免污染真实 settings.json）
// 运行（真机/沙箱）：npx electron test_config.js --no-sandbox
const { app } = require('electron')
const path = require('path')
const os = require('os')
const fs = require('fs')

const tmp = path.join(os.tmpdir(), 'screen-ocr-test-' + Date.now())
app.setPath('userData', tmp)

let fails = 0
function eq(name, actual, expect) {
  if (actual === expect) console.log('[PASS]', name, '=>', JSON.stringify(expect))
  else { console.log('[FAIL]', name, '=> got', JSON.stringify(actual), 'expect', JSON.stringify(expect)); fails++ }
}

app.whenReady().then(() => {
  try {
    const { getAll, get, set, update, DEFAULTS } = require('../src/main/config')

    // 默认值
    eq('默认 shortcut', get('shortcut'), DEFAULTS.shortcut)
    eq('默认 autoLaunch', get('autoLaunch'), false)

    // set / get
    set('shortcut', 'CommandOrControl+Alt+Z')
    eq('set 后 get shortcut', get('shortcut'), 'CommandOrControl+Alt+Z')

    // update 多项
    update({ autoLaunch: true, captureOnLaunch: false, autoCloseAfterCopy: false })
    eq('update autoLaunch', get('autoLaunch'), true)
    eq('update captureOnLaunch', get('captureOnLaunch'), false)
    eq('update autoCloseAfterCopy', get('autoCloseAfterCopy'), false)
    eq('shortcut 未被 update 影响', get('shortcut'), 'CommandOrControl+Alt+Z')

    // 持久化：文件内容正确
    const file = path.join(tmp, 'settings.json')
    eq('settings.json 已生成', fs.existsSync(file), true)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    eq('文件里 shortcut', saved.shortcut, 'CommandOrControl+Alt+Z')
    eq('文件里 autoLaunch', saved.autoLaunch, true)

    console.log(fails === 0 ? '\n[ALL PASS]' : '\n[' + fails + ' FAILED]')
    if (fails) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
