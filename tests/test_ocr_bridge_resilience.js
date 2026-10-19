// OcrBridge 健壮性测试：进程不 ready / 不回包 / 请求时崩溃 / 脏输出 / 空输入
// 运行：node tests/test_ocr_bridge_resilience.js
// 不依赖 Electron 与真实模型：用 tests/fixtures/fake-ocr-server.js 当 sidecar。
const path = require('path')

process.env.SCREEN_OCR_PYTHON = process.execPath // 用 node 跑假 sidecar
process.env.SCREEN_OCR_SCRIPT = path.join(__dirname, 'fixtures', 'fake-ocr-server.js')
process.env.SCREEN_OCR_READY_TIMEOUT = '600'
process.env.SCREEN_OCR_REQUEST_TIMEOUT = '800'

const { OcrBridge } = require('../src/main/ocr-bridge')

let failed = 0
function check(name, cond, detail) {
  if (cond) console.log('  [OK]   ' + name + (detail ? '  ' + detail : ''))
  else { failed++; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')) }
}

const B64 = 'aGVsbG8=' // "hello"，假 sidecar 不解码，只验证链路

async function withMode(mode, fn) {
  process.env.FAKE_MODE = mode
  const bridge = new OcrBridge('balanced')
  try {
    return await fn(bridge)
  } finally {
    bridge.close()
    await new Promise((r) => setTimeout(r, 50))
  }
}

// 在限定时间内必须 settle：把"永久挂起"变成可断言的失败
function within(promise, ms = 4000) {
  return Promise.race([
    promise.then((v) => ({ ok: true, value: v })).catch((e) => ({ ok: false, error: e.message })),
    new Promise((r) => setTimeout(() => r({ ok: false, error: 'TIMEOUT_TEST_HARNESS' }), ms))
  ])
}

;(async () => {
  console.log('\n== 正常链路 ==')
  {
    const r = await withMode('normal', (b) => within(b.recognizeBase64(B64)))
    check('正常识别返回结果', r.ok && r.value.texts[0] === 'fake-line', JSON.stringify(r.value || r.error))
  }

  console.log('\n== 脏输出（非 JSON 行）==')
  {
    const r = await withMode('garbage', (b) => within(b.recognizeBase64(B64)))
    check('非 JSON 输出被忽略且仍能识别', r.ok && r.value.texts.length === 1, JSON.stringify(r.value || r.error))
  }

  console.log('\n== sidecar 一直不 ready ==')
  {
    const t0 = Date.now()
    const r = await withMode('no-ready', (b) => within(b.recognizeBase64(B64), 6000))
    const cost = Date.now() - t0
    check('不 ready 时按超时失败（不永久挂起）', !r.ok && r.error === 'E_OCR_READY_TIMEOUT', r.error)
    check('超时时间受配置约束（< 6s）', cost < 6000, cost + 'ms')
  }

  console.log('\n== sidecar 收到请求后不回复 ==')
  {
    const r = await withMode('silent', (b) => within(b.recognizeBase64(B64), 6000))
    check('单请求超时返回 E_OCR_TIMEOUT', !r.ok && r.error === 'E_OCR_TIMEOUT', r.error)
  }

  console.log('\n== 请求时进程崩溃（应重试一次后失败，不无限重试）==')
  {
    const r = await withMode('crash-on-request', (b) => within(b.recognizeBase64(B64), 6000))
    check('崩溃后返回 E_OCR_EXITED', !r.ok && r.error === 'E_OCR_EXITED', r.error)
  }

  console.log('\n== 空输入 ==')
  {
    const bridge = new OcrBridge('balanced')
    const r = await within(bridge.recognizeBase64(''), 1000)
    check('空 base64 立即报 E_EMPTY_SELECTION', !r.ok && r.error === 'E_EMPTY_SELECTION', r.error)
    bridge.close()
  }

  console.log('\n' + (failed === 0 ? '[ALL PASS] OcrBridge 健壮性通过' : '[FAIL] 共 ' + failed + ' 项失败'))
  process.exit(failed === 0 ? 0 : 1)
})()
