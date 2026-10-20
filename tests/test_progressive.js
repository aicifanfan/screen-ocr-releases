// 两段式渐进（E1）协议测试：临时结果先回、精修结果异步推送、空结果边界。
// 用假 sidecar 驱动 OcrBridge，不依赖真实模型，秒级完成。
const assert = require('assert')
const path = require('path')

process.env.SCREEN_OCR_PYTHON = process.execPath // 用 node 冒充 python 跑假侧车
process.env.SCREEN_OCR_SCRIPT = path.join(__dirname, 'fixtures', 'fake-ocr-server.js')
process.env.SCREEN_OCR_READY_TIMEOUT = '5000'
process.env.SCREEN_OCR_REQUEST_TIMEOUT = '8000'

const { OcrBridge } = require('../src/main/ocr-bridge')

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''))
}

const PNG = 'data:image/png;base64,' + Buffer.from('fake').toString('base64')

async function run(mode) {
  process.env.FAKE_MODE = mode
  const bridge = new OcrBridge('accurate')
  const refined = []
  bridge.onRefined = (msg) => refined.push({ msg, at: Date.now() })
  await bridge.init()

  const t0 = Date.now()
  const res = await bridge.recognizeBase64(PNG.replace('data:image/png;base64,', ''))
  const firstMs = Date.now() - t0
  const firstAt = Date.now()

  // 等精修结果（流式会推多条，最多等 2s）
  const deadline = Date.now() + 2000
  while (refined.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30))

  await bridge.close()
  return { res, firstMs, firstAt, refined }
}

;(async () => {
  // 1) 正常流程：临时结果立即返回，精修分批推送
  const a = await run('progressive')
  check('渐进：临时结果先返回（stage=provisional）', a.res.stage === 'provisional', a.res.stage)
  check('渐进：临时结果文本正确', JSON.stringify(a.res.texts) === JSON.stringify(['fast-1', 'fast-2']),
    JSON.stringify(a.res.texts))
  check('渐进：演示用时 < 500ms（不被精修阻塞）', a.firstMs < 500, a.firstMs + 'ms')
  check('流式：精修至少分两批推送', a.refined.length >= 2, '条数=' + a.refined.length)
  if (a.refined.length >= 2) {
    const first = a.refined[0].msg
    const last = a.refined[a.refined.length - 1].msg
    check('流式：中间批次标记 final=false', first.final === false, 'final=' + first.final)
    check('流式：最后一批标记 final=true', last.final === true, 'final=' + last.final)
    check('流式：所有批次 seq 一致（能定位到同一次截图）',
      a.refined.every((r) => r.msg.seq === a.res.seq), 'seq=' + a.res.seq)
    check('流式：行数从头到尾不变（选中位置不会错乱）',
      a.refined.every((r) => Array.isArray(r.msg.texts) && r.msg.texts.length === 2),
      a.refined.map((r) => r.msg.texts.length).join(','))
    check('流式：done 单调递增到 total',
      a.refined.every((r, i) => r.msg.done <= r.msg.total && (i === 0 || r.msg.done >= a.refined[i - 1].msg.done)) &&
      last.done === last.total,
      a.refined.map((r) => r.msg.done + '/' + r.msg.total).join(' → '))
    check('流式：中间批次只替换已完成的行', JSON.stringify(first.texts) === JSON.stringify(['precise-1', 'fast-2']),
      JSON.stringify(first.texts))
    check('流式：最后一批全部为 medium 结果',
      JSON.stringify(last.texts) === JSON.stringify(['precise-1', 'precise-2']), JSON.stringify(last.texts))
    check('流式：精修在临时结果之后到达', a.refined[0].at >= a.firstAt, (a.refined[0].at - a.firstAt) + 'ms 后')
  }

  // 2) 边界：没有任何识别行时也要推 refined，否则 UI 永远停在「精修中」
  const b = await run('progressive-empty')
  check('空结果：临时结果行数为 0', Array.isArray(b.res.texts) && b.res.texts.length === 0)
  check('空结果：仍然推送 refined（UI 能收起提示）', b.refined.length === 1, '次数=' + b.refined.length)
  if (b.refined.length) {
    check('空结果：refined=false 表示没有可精修的行', b.refined[0].msg.refined === false)
  }

  // 3) 回归：非渐进模式不应产生 refined 消息，也不影响原有返回
  const c = await run('normal')
  await new Promise((r) => setTimeout(r, 250))
  check('回归：普通模式返回 ok 类型', c.res.type === 'ok', c.res.type)
  check('回归：普通模式不产生 refined 消息', c.refined.length === 0, '次数=' + c.refined.length)

  console.log(pass ? '[ALL PASS] 渐进式协议（临时结果 + 精修推送 + 空结果边界）通过' : '[FAIL] 存在未通过项')
  process.exit(pass ? 0 : 1)
})().catch((e) => {
  console.error('[FAIL] 未捕获异常:', e && e.message)
  process.exit(1)
})
