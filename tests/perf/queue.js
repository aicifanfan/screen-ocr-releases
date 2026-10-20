// 队头阻塞回归检查：精修进行中再截图，新请求能否很快拿到结果。
//
// 背景：sidecar 是单线程循环，早期版本把「整轮 medium 精修」放在 recognize 处理里，
// 这期间到来的「切换档位 / 下一次截图」全部排队。实测 97 行精修会把后续请求卡住 102 秒，
// 正好撞上主进程 90 秒的请求超时，用户看到「识别超时」，还容易误判成档位映射错了。
//
// 现在的行为：精修每批之间检查队列，有新请求就提前收尾，让路给新请求。
//
// 用法：
//   node tests/perf/queue.js                      # 默认用 lines-17
//   node tests/perf/queue.js --image shot-2560
//   node tests/perf/queue.js --exe <侧车路径>      # 指定别的构建做对比
//   SCREEN_OCR_PYTHON=.venv-perf/Scripts/python.exe node tests/perf/queue.js --image shot-2560  # 跑源码
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const argv = process.argv.slice(2)
const getArg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}
const IMAGE = getArg('image', 'lines-17')
const PY = process.env.SCREEN_OCR_PYTHON
const EXE = getArg('exe', PY || path.join(ROOT, 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe'))
const ARGS = PY && !argv.includes('--exe') ? [path.join(ROOT, 'python', 'ocr_server.py')] : []
const CMD = PY && !argv.includes('--exe') ? PY : EXE

// 判据：新请求必须在 20 秒内返回（旧行为是「等完整轮精修」，动辄 60-100s）
const MAX_WAIT_MS = Number(getArg('max', '20000'))

const imgPath = path.join(__dirname, IMAGE + '.b64')
if (!fs.existsSync(imgPath)) {
  console.error('[SKIP] 缺少测试图 ' + imgPath + '，先跑 node tests/perf/gen.js 生成')
  process.exit(0)
}
const IMG = fs.readFileSync(imgPath, 'utf8').trim()

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''))
}

const proc = spawn(CMD, ARGS, { env: { ...process.env, SCREEN_OCR_PROFILE: 'accurate' } })
let buf = ''
const t = { start: 0, switch: 0 }
let sawFirst = false
let refineFinal = null
let secondMs = null

proc.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line || line.startsWith('[')) continue
    let m
    try { m = JSON.parse(line) } catch { continue }

    if (m.type === 'ready') {
      t.start = Date.now()
      proc.stdin.write(JSON.stringify({ type: 'recognize', image: IMG, seq: 1 }) + '\n')
      // 800ms 后（精修已在跑）：切档 + 立刻再发一次识别，模拟「用户马上又截了一张」
      setTimeout(() => {
        t.switch = Date.now()
        proc.stdin.write(JSON.stringify({ type: 'setProfile', profile: 'balanced', seq: 900 }) + '\n')
        proc.stdin.write(JSON.stringify({ type: 'recognize', image: IMG, seq: 2 }) + '\n')
      }, 800)
      continue
    }
    if (m.type === 'result' && m.seq === 1) sawFirst = true
    if (m.type === 'refined' && m.seq === 1 && m.final) {
      refineFinal = { done: m.done, total: m.total, ms: Date.now() - t.start }
    }
    if (m.type === 'result' && m.seq === 2) {
      secondMs = Date.now() - t.switch
      proc.stdin.write('{"type":"exit"}\n')
    }
  }
})

setTimeout(() => {
  try { proc.kill() } catch { /* 已退出 */ }
  check('精修期间发出的新请求有结果返回', secondMs != null, secondMs == null ? '没等到 seq=2' : secondMs + 'ms')
  if (secondMs != null) {
    check('新请求没被整轮精修卡住（<' + (MAX_WAIT_MS / 1000) + 's）', secondMs < MAX_WAIT_MS, secondMs + 'ms')
  }
  if (refineFinal) {
    check('旧的精修被提前收尾（done < total）', refineFinal.done < refineFinal.total,
      refineFinal.done + '/' + refineFinal.total + '，用时 ' + refineFinal.ms + 'ms')
  } else {
    check('旧的精修有 final 包（UI 能收起「精修中」）', false, '没收到 final')
  }
  check('第一次识别照常出了结果', sawFirst)
  console.log(pass ? '[ALL PASS] 精修不阻塞后续请求' : '[FAIL] 存在未通过项')
  process.exit(pass ? 0 : 1)
}, 45000)
