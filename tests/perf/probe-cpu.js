// 采 CPU 占用：判断 accurate 档到底吃满了几核（决定「线程/并行」类优化是否值得）
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SCRIPT = path.join(__dirname, '..', '..', 'python', 'ocr_server.py')
// SCREEN_OCR_PYTHON 指向 python.exe 时改跑源码（便于在改参数前先验证逻辑）
const PY = process.env.SCREEN_OCR_PYTHON
const EXE = PY || path.join(__dirname, '..', '..', 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe')
const ARGS = PY ? [SCRIPT] : []
const image = fs.readFileSync(path.join(__dirname, 'lines-17.b64'), 'utf8').trim()

function cpuSeconds(pid) {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds"`,
      { encoding: 'utf8', timeout: 8000 }
    ).trim()
    return parseFloat(out)
  } catch { return NaN }
}

function runProfile(profile) {
  return new Promise((resolve) => {
    const proc = spawn(EXE, ARGS, { env: { ...process.env, SCREEN_OCR_PROFILE: profile } })
    let buf = ''
    let seq = 0
    const pending = new Map()
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        let m; try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'ready') start()
        else if (m.seq != null && pending.has(m.seq)) { pending.get(m.seq)(m); pending.delete(m.seq) }
      }
    })
    const ask = (msg) => new Promise((res) => { const s = ++seq; pending.set(s, res); proc.stdin.write(JSON.stringify({ ...msg, seq: s }) + '\n') })
    async function start() {
      await ask({ type: 'recognize', image }) // 预热
      const c0 = cpuSeconds(proc.pid)
      const t0 = Date.now()
      const r = await ask({ type: 'recognize', image })
      const wall = (Date.now() - t0) / 1000
      const c1 = cpuSeconds(proc.pid)
      const cores = (c1 - c0) / wall
      console.log(`${profile.padEnd(9)} engine=${String(Math.round(r.elapse_ms)).padStart(6)}ms  cpu=${(c1 - c0).toFixed(2)}s  wall=${wall.toFixed(2)}s  avg_cores=${cores.toFixed(2)} / ${os.cpus().length}`)
      proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
      resolve()
    }
  })
}

;(async () => {
  console.log('cpus=' + os.cpus().length)
  for (const p of ['fast', 'balanced', 'accurate']) await runProfile(p)
  process.exit(0)
})()
