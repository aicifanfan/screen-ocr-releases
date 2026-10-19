// 回归测试：OCR 档位「设置页改了但引擎没变」的链路
// 背景（2026-10-19）：config.update 就地改写缓存对象 → settings:set 里
// `partial.ocrProfile !== old.ocrProfile` 永远为 false → 切「均衡」从不生效，
// 引擎一直跑 accurate，表现为"改了设置还是很慢"。
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TMP = path.join(os.tmpdir(), 'screen-ocr-profile-test-' + process.pid)
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
app.setPath('userData', TMP)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

process.env.SCREEN_OCR_PYTHON = process.execPath
process.env.SCREEN_OCR_SCRIPT = path.join(__dirname, 'fixtures', 'fake-ocr-server.js')
process.env.SCREEN_OCR_READY_TIMEOUT = '4000'
process.env.SCREEN_OCR_REQUEST_TIMEOUT = '5000'
// 本进程是 Electron 主进程，process.execPath 是 electron.exe；
// 让子进程以纯 Node 方式运行（否则它会去启动一个 App 然后立刻退出）
process.env.ELECTRON_RUN_AS_NODE = '1'

const { OcrBridge } = require('../src/main/ocr-bridge')

let failed = 0
function check(name, cond, detail) {
  if (cond) console.log('  [OK]   ' + name + (detail ? '  ' + detail : ''))
  else { failed++; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')) }
}

async function newBridge(profile) {
  const b = new OcrBridge(profile)
  await b.init()
  return b
}

app.whenReady().then(async () => {
  try {
    // —— 1. 配置对象不被就地改写（这条是根因回归） ——
    console.log('\n== 配置快照 ==')
    const cfg = require('../src/main/config')
    cfg.update({ ocrProfile: 'accurate' })

    const old = cfg.getAll()               // 与 settings:set 的写法一致
    cfg.update({ ocrProfile: 'balanced' }) // 设置页点保存

    check('update 不就地改写已取出的配置对象', old.ocrProfile === 'accurate', 'old=' + old.ocrProfile)
    check('缓存确实已更新', cfg.getAll().ocrProfile === 'balanced', cfg.getAll().ocrProfile)
    check('「档位是否变化」判断成立', 'balanced' !== old.ocrProfile, '应为 true')

    // —— 2. OcrBridge.setProfile 的行为 ——
    console.log('\n== 引擎侧切换 ==')
    delete process.env.FAKE_MODE
    {
      const b = await newBridge('accurate')
      check('启动后采用 sidecar 回报的档位', b.profile === 'accurate', b.profile)

      const ok = await b.setProfile('balanced')
      check('切到 balanced 返回 true', ok === true, String(ok))
      check('bridge.profile 跟随引擎', b.profile === 'balanced', b.profile)

      const again = await b.setProfile('balanced')
      check('重复设置为同一档位直接返回 false（不重复下发）', again === false, String(again))

      const bad = await b.setProfile('ultra')
      check('非法档位返回 false 且不改状态', bad === false && b.profile === 'balanced', b.profile)
      b.close()
    }

    // —— 3. 引擎回退时不谎报成功 ——
    console.log('\n== 档位回退 ==')
    {
      process.env.FAKE_MODE = 'fallback'
      const b = await newBridge('accurate')
      const ok = await b.setProfile('fast')
      check('引擎回退到 balanced 时返回 false', ok === false, String(ok))
      check('bridge.profile 以引擎实际档位为准', b.profile === 'balanced', b.profile)
      b.close()
      delete process.env.FAKE_MODE
    }

    console.log('\n' + (failed === 0 ? '[ALL PASS] 档位链路通过' : '[FAIL] 共 ' + failed + ' 项失败'))
  } catch (e) {
    failed++
    console.error('[FAIL] 异常:', e && e.stack ? e.stack : e)
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
    setTimeout(() => app.exit(failed === 0 ? 0 : 1), 100)
  }
})
