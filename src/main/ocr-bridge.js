// OCR 桥接：spawn Python 子进程，通过 stdio 逐行 JSON 通信
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

class OcrBridge {
  constructor(profile) {
    this.proc = null
    this.ready = false
    this.profile = profile || 'balanced' // fast / balanced / accurate
    this.pending = new Map() // seq -> { resolve, reject }
    this.seq = 0
    this._readyResolve = null
  }

  _resolvePython() {
    // 打包后：优先使用 extraResources 里的 ocr_server 目录（onedir 结构）
    const exe = path.join(process.resourcesPath || '', 'ocr_server', 'ocr_server.exe')
    if (fs.existsSync(exe)) return { cmd: exe, args: [] }

    // 开发期：优先环境变量指定的 python，否则用系统 python
    const py = process.env.SCREEN_OCR_PYTHON || 'python'
    const script = path.join(__dirname, '..', '..', 'python', 'ocr_server.py')
    return { cmd: py, args: [script] }
  }

  async init() {
    if (this.proc) return this._waitReady()
    const { cmd, args } = this._resolvePython()

    this.proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 通过环境变量把识别档位传给 sidecar（balanced 为默认，速度/精度均衡）
      env: { ...process.env, SCREEN_OCR_PROFILE: this.profile }
    })

    this.proc.stderr.on('data', (d) => console.error('[ocr:stderr]', d.toString().trim()))
    this.proc.on('error', (e) => console.error('[ocr] 启动失败：', e.message))
    this.proc.on('exit', (code) => {
      console.error('[ocr] 子进程退出，code =', code)
      this.proc = null
      this.ready = false
      // 挂起的请求全部失败
      for (const [, p] of this.pending) p.reject(new Error('OCR 子进程已退出'))
      this.pending.clear()
    })

    let buf = ''
    this.proc.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) this._onLine(line)
      }
    })

    return this._waitReady()
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }

    if (msg.type === 'ready') {
      this.ready = true
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null }
      return
    }

    const seq = msg.seq
    if (seq != null && this.pending.has(seq)) {
      const { resolve, reject } = this.pending.get(seq)
      this.pending.delete(seq)
      if (msg.type === 'error') reject(new Error(msg.message))
      else resolve(msg)
    }
  }

  _waitReady() {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve) => { this._readyResolve = resolve })
  }

  _send(msg) {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq
      this.pending.set(seq, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ ...msg, seq }) + '\n')
    })
  }

  /** 识别一张图片（PNG Buffer），返回 { texts, boxes, scores, elapse_ms } */
  async recognize(imageBuffer) {
    await this.init()
    const b64 = imageBuffer.toString('base64')
    return this._send({ type: 'recognize', image: b64 })
  }

  /** 运行时切换识别档位（fast / balanced / accurate），无需重启 sidecar */
  async setProfile(profile) {
    const p = String(profile || '').trim().toLowerCase()
    if (!['fast', 'balanced', 'accurate'].includes(p) || p === this.profile) return false
    this.profile = p
    if (!this.proc) return true // 尚未启动：下次 init 会用新档位
    try {
      await this._send({ type: 'setProfile', profile: p })
      return true
    } catch {
      return false
    }
  }

  close() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n') } catch {}
      this.proc = null
      this.ready = false
    }
  }
}

module.exports = { OcrBridge }
