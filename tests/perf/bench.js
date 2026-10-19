// 用打包版 sidecar 实测：档位 × 输入分辨率
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const EXE = path.join(__dirname, '..', '..', 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe')
const IMAGES = ['shot-2560', 'shot-1600', 'shot-1280', 'shot-960', 'blank-1600']
const PROFILES = ['fast', 'balanced', 'accurate']

function b64(name) {
  return fs.readFileSync(path.join(__dirname, name + '.b64'), 'utf8').trim()
}

function runProfile(profile) {
  return new Promise((resolve) => {
    const proc = spawn(EXE, [], { env: { ...process.env, SCREEN_OCR_PROFILE: profile } })
    let buf = ''
    let seq = 0
    const pending = new Map()
    let readyCb = null
    const out = []

    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'ready') { if (readyCb) readyCb(m); continue }
        if (m.type === 'warn') { console.log('  [warn]', m.message); continue }
        if (m.seq != null && pending.has(m.seq)) {
          pending.get(m.seq)(m)
          pending.delete(m.seq)
        }
      }
    })
    proc.stderr.on('data', () => {})

    const ask = (msg) => new Promise((res) => {
      const s = ++seq
      pending.set(s, res)
      proc.stdin.write(JSON.stringify({ ...msg, seq: s }) + '\n')
    })

    readyCb = async (m) => {
      console.log(`  [${profile}] ready init_ms=${m.init_ms} profile=${m.profile}`)
      for (const name of IMAGES) {
        const image = b64(name)
        // 预热一次（首帧含 ORT 图优化 / 内存分配）
        await ask({ type: 'recognize', image })
        const times = []
        let lines = 0
        for (let k = 0; k < 2; k++) {
          const t0 = Date.now()
          const r = await ask({ type: 'recognize', image })
          times.push({ wall: Date.now() - t0, engine: r.elapse_ms, lines: (r.texts || []).length })
          lines = (r.texts || []).length
        }
        const best = times.reduce((a, b) => (a.engine <= b.engine ? a : b))
        out.push({ name, ms: best.engine, wall: best.wall, lines })
        console.log(`    ${name.padEnd(12)} engine=${String(Math.round(best.engine)).padStart(6)}ms wall=${String(best.wall).padStart(6)}ms lines=${best.lines}`)
      }
      proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
      resolve(out)
    }
  })
}

;(async () => {
  for (const p of PROFILES) await runProfile(p)
  process.exit(0)
})()
