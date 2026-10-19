// 端到端时延：每张图测「首次看到文字」与「最终结果」两个时间点。
// 0.3.x 的 accurate 档会先回 provisional 再推 refined；旧版本只有一次 result（两个时间点相同）。
//
// 用法：
//   node tests/perf/latency.js                          # 当前侧车
//   node tests/perf/latency.js --exe python/ocr_pkg_prev_024_old/ocr_server.exe
//   node tests/perf/latency.js --image shot-2560 --runs 3 --profile accurate
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}

const EXE = arg('exe', path.join(ROOT, 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe'))
const IMAGE = arg('image', 'lines-17')
const RUNS = Number(arg('runs', '3'))
const PROFILES = (arg('profile') || 'fast,balanced,accurate').split(',')
const WARM = arg('warm', '1') !== '0'

const image = fs.readFileSync(path.join(__dirname, IMAGE + '.b64'), 'utf8').trim()

function runProfile(profile) {
  return new Promise((resolve) => {
    const proc = spawn(EXE, [], { env: { ...process.env, SCREEN_OCR_PROFILE: profile } })
    let buf = ''
    let seq = 0
    const pending = new Map()
    let waiters = null // 当前这一轮的采集器
    let progressive = false // 由 ready 消息决定，必须先声明再在回调里用（否则 TDZ）

    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }

        if (m.type === 'ready') { start(m); continue }
        if (m.type === 'warn') continue

        // 预热请求的回包（ask() 的 Promise 靠这里兑现）；测量请求不进 pending
        if (m.seq != null && pending.has(m.seq)) {
          pending.get(m.seq)(m)
          pending.delete(m.seq)
          continue
        }

        if (waiters) {
          if (m.type === 'result') {
            waiters.provisional = Date.now() - waiters.t0
            waiters.lines = (m.texts || []).length
            // 旧版本没有两段式：result 就是最终结果
            if (!progressive) {
              waiters.final = waiters.provisional
              const w = waiters; waiters = null; w.done(w)
            }
          }
          if (m.type === 'refined') {
            waiters.final = Date.now() - waiters.t0
            if (m.lines && !waiters.lines) waiters.lines = m.lines
            const w = waiters
            waiters = null
            w.done(w)
          }
          if (m.type === 'error') {
            const w = waiters
            waiters = null
            w.done({ error: m.message })
          }
        }
      }
    })
    proc.stderr.on('data', () => {})

    const ask = () => new Promise((res) => {
      const s = ++seq
      pending.set(s, res)
      proc.stdin.write(JSON.stringify({ type: 'recognize', image, seq: s }) + '\n')
    })

    async function start(ready) {
      progressive = !!ready.progressive
      if (WARM) await ask() // 预热：排除首帧的图优化开销

      const samples = []
      for (let k = 0; k < RUNS; k++) {
        const t0 = Date.now()
        const rec = await new Promise((res) => {
          waiters = { t0, provisional: null, final: null, lines: 0, done: res }
          // 兜底：单次请求最多等 180s，避免旧版本/异常导致挂死
          const guard = setTimeout(() => { if (waiters) { const w = waiters; waiters = null; w.done({ error: 'TIMEOUT' }) } }, 180000)
          const orig = res
          waiters.done = (v) => { clearTimeout(guard); orig(v) }
          proc.stdin.write(JSON.stringify({ type: 'recognize', image, seq: ++seq }) + '\n')
        })
        samples.push(rec)
      }
      proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
      setTimeout(() => { try { proc.kill() } catch { /* 已退出 */ } }, 300)

      const med = (arr) => {
        const v = arr.filter((x) => typeof x === 'number').sort((a, b) => a - b)
        if (!v.length) return null
        return v[Math.floor(v.length / 2)]
      }
      resolve({
        profile: ready.profile,
        progressive: !!ready.progressive,
        threads: ready.threads,
        warmup: ready.warmup_ms,
        provisional: med(samples.map((s) => s.provisional)),
        final: med(samples.map((s) => s.final)),
        lines: samples[0] ? samples[0].lines : 0,
      })
    }
  })
}

;(async () => {
  if (!fs.existsSync(EXE)) {
    console.error('找不到 sidecar：' + EXE)
    process.exit(2)
  }
  console.log('sidecar: ' + path.relative(ROOT, EXE) + '   图片: ' + IMAGE + '   轮次: ' + RUNS)
  console.log('档位       首次出字      最终结果      行数  说明')
  const rows = []
  for (const p of PROFILES) {
    const r = await runProfile(p)
    rows.push(r)
    const first = r.provisional == null ? '?' : Math.round(r.provisional) + 'ms'
    const fin = r.final == null ? '?' : Math.round(r.final) + 'ms'
    const note = r.progressive ? '两段式（先出后精修）' : '一次算完'
    console.log(`${r.profile.padEnd(9)} ${first.padStart(9)} ${fin.padStart(12)} ${String(r.lines).padStart(6)}  ${note}`)
  }
  process.exit(0)
})()
