// 假 sidecar：用 FAKE_MODE 模拟各种异常，验证 OcrBridge 的超时/重试/退出处理。
// 用法（由 test_ocr_bridge_resilience.js 拉起）：
//   SCREEN_OCR_PYTHON=node SCREEN_OCR_SCRIPT=<本文件> FAKE_MODE=normal|no-ready|silent|crash-on-request|garbage
const mode = process.env.FAKE_MODE || 'normal'

const send = (obj) => {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* 对端已关闭 */ }
}

if (mode === 'garbage') process.stdout.write('this is not json\n')
if (mode !== 'no-ready') send({ type: 'ready', profile: 'balanced' })

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
    if (msg.type === 'setProfile') { send({ type: 'profileChanged', seq: msg.seq, profile: msg.profile }); continue }
    if (msg.type === 'recognize') {
      send({ type: 'ok', seq: msg.seq, texts: ['fake-line'], boxes: [[0, 0, 10, 10]], scores: [0.9], elapse_ms: 1, profile: 'balanced' })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
