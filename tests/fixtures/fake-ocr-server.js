// 假 sidecar：用 FAKE_MODE 模拟各种异常，验证 OcrBridge 的超时/重试/退出处理。
// 用法（由 test_ocr_bridge_resilience.js 拉起）：
//   SCREEN_OCR_PYTHON=node SCREEN_OCR_SCRIPT=<本文件> FAKE_MODE=normal|no-ready|silent|crash-on-request|garbage
const mode = process.env.FAKE_MODE || 'normal'

const send = (obj) => {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* 对端已关闭 */ }
}

if (mode === 'garbage') process.stdout.write('this is not json\n')
if (mode !== 'no-ready') send({ type: 'ready', profile: process.env.SCREEN_OCR_PROFILE || 'balanced' })

let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }

    if (msg.type === 'exit') process.exit(0)
    if (mode === 'silent') continue
    if (mode === 'crash-on-request') process.exit(1)
    if (msg.type === 'setProfile') {
      // fallback 模式：模拟「请求的档位模型不可用，引擎回退到 balanced」
      const profile = mode === 'fallback' ? 'balanced' : msg.profile
      send({ type: 'profileChanged', seq: msg.seq, profile, init_ms: 0 })
      continue
    }
    if (msg.type === 'recognize') {
      // 渐进模式：先回临时结果，200ms 后再推最终结果（模拟两段式）
      if (mode === 'progressive') {
        send({ type: 'result', seq: msg.seq, stage: 'provisional', texts: ['fast-1', 'fast-2'],
          boxes: [[0, 0, 10, 10], [0, 10, 10, 20]], scores: [0.8, 0.8], elapse_ms: 5, profile: 'accurate' })
        setTimeout(() => {
          send({ type: 'refined', seq: msg.seq, texts: ['precise-1', 'precise-2'], scores: [0.99, 0.99],
            refined: true, lines: 2, refine_ms: 180, elapse_ms: 200, profile: 'accurate' })
        }, 200)
        continue
      }
      // 渐进 + 空结果边界：没有识别到任何行时也必须推一条 refined，否则 UI 会一直显示「精修中」
      if (mode === 'progressive-empty') {
        send({ type: 'result', seq: msg.seq, stage: 'provisional', texts: [], boxes: [], scores: [], elapse_ms: 3, profile: 'accurate' })
        setTimeout(() => {
          send({ type: 'refined', seq: msg.seq, texts: [], scores: [], refined: false, lines: 0, refine_ms: 1, elapse_ms: 10, profile: 'accurate' })
        }, 80)
        continue
      }
      send({ type: 'ok', seq: msg.seq, texts: ['fake-line'], boxes: [[0, 0, 10, 10]], scores: [0.9], elapse_ms: 1, profile: 'balanced' })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
