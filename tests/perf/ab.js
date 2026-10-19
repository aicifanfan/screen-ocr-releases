// A/B：同一张图跑多组环境变量配置，输出 engine 耗时（取多次最小值）
// 用法：node tests/perf/ab.js [--image lines-17] [--runs 2]
// 通过 SCREEN_OCR_PYTHON 可切到源码模式；默认跑打包版 exe。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const SCRIPT = path.join(ROOT, 'python', 'ocr_server.py')

const argv = process.argv.slice(2)
const getArg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}

// 优先 --exe，其次 SCREEN_OCR_PYTHON（源码模式），最后默认打包产物
// 想对比「改版前/改版后」，可以把旧 exe 拷到别处用 --exe 指过去。
const PY = process.env.SCREEN_OCR_PYTHON
const EXE = getArg('exe', null) || PY ||
  path.join(ROOT, 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe')
const ARGS = (!getArg('exe', null) && PY) ? [SCRIPT] : []

const IMAGE = getArg('image', 'lines-17')
const RUNS = Number(getArg('runs', '2'))
const ONLY = getArg('only', '')

// 配置矩阵：名字 + 环境变量。baseline 放首尾各一次，用于检查机器负载漂移。
const CONFIGS = [
  { name: '0.2.4 默认(自适配)', env: { SCREEN_OCR_PROFILE: 'accurate' } },
  { name: 'baseline(8线程,det medium)', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '8', SCREEN_OCR_DET_TYPE: 'medium' } },
  { name: 'A1  threads=16', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '16', SCREEN_OCR_DET_TYPE: 'medium' } },
  { name: 'A1  threads=24', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '24', SCREEN_OCR_DET_TYPE: 'medium' } },
  { name: 'B1  det=small,8线程', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '8', SCREEN_OCR_DET_TYPE: 'small' } },
  { name: 'A1+B1 16线程,det=small', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '16', SCREEN_OCR_DET_TYPE: 'small' } },
  { name: 'A1+B1 24线程,det=small', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '24', SCREEN_OCR_DET_TYPE: 'small' } },
  { name: 'baseline 复测', env: { SCREEN_OCR_PROFILE: 'accurate', SCREEN_OCR_THREADS: '8', SCREEN_OCR_DET_TYPE: 'medium' } },
]

function runOne(cfg) {
  return new Promise((resolve) => {
    const proc = spawn(EXE, ARGS, { env: { ...process.env, ...cfg.env } })
    let buf = ''
    let seq = 0
    const pending = new Map()
    const image = fs.readFileSync(path.join(__dirname, IMAGE + '.b64'), 'utf8').trim()

    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'ready') onReady(m)
        else if (m.type === 'warn') console.log('    [warn]', m.message)
        else if (m.seq != null && pending.has(m.seq)) { pending.get(m.seq)(m); pending.delete(m.seq) }
      }
    })
    proc.stderr.on('data', () => {})

    const ask = (msg) => new Promise((res) => {
      const s = ++seq
      pending.set(s, res)
      proc.stdin.write(JSON.stringify({ ...msg, seq: s }) + '\n')
    })

    async function onReady(ready) {
      const times = []
      for (let i = 0; i < RUNS; i++) {
        const r = await ask({ type: 'recognize', image })
        times.push(r.elapse_ms)
      }
      proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
      setTimeout(() => { try { proc.kill() } catch {} }, 500)
      resolve({ ready, times, best: Math.min(...times), profile: ready.profile })
    }
  })
}

;(async () => {
  if (!fs.existsSync(path.join(__dirname, IMAGE + '.b64'))) {
    console.error('缺少基准图 ' + IMAGE + '.b64，先跑 gen.js / gen-lines.js')
    process.exit(2)
  }
  const base = []
  for (const cfg of CONFIGS.filter((c) => !ONLY || c.name.includes(ONLY))) {
    const r = await runOne(cfg)
    const tag = r.profile === 'accurate' ? '' : '  <-- 档位回退了！'
    console.log(`${cfg.name.padEnd(28)} ${String(Math.round(r.best)).padStart(7)}ms  [线程 ${r.ready.threads}]${tag}`)
    if (cfg.name.startsWith('baseline')) base.push(r.best)
  }
  const b0 = Math.min(...base)
  console.log(`\n基准（baseline 取最小）: ${Math.round(b0)}ms`)
  process.exit(0)
})()
