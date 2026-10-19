// OCR 桥接：spawn Python 子进程，通过 stdio 逐行 JSON 通信
//
// 健壮性约定（改之前先看）：
//   1. 任何等待都有上限：sidecar 冷启动 25s、单次识别 90s（accurate 大图实测 40s+）；
//   2. 进程退出 / 写入失败 / 超时都必须让挂起的请求失败，不能把 UI 永久挂在骨架屏上；
//   3. 只在「进程没了」时自动重启重试一次；超时不重试（避免同一张图把 CPU 打满两遍）。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

// 超时可被环境变量覆盖：自动化测试用小值，避免真的等 25s/90s
const READY_TIMEOUT = Number(process.env.SCREEN_OCR_READY_TIMEOUT) || 25000
const REQUEST_TIMEOUT = Number(process.env.SCREEN_OCR_REQUEST_TIMEOUT) || 90000
const RETRYABLE = /E_OCR_(EXITED|NOT_RUNNING|SPAWN)/

class OcrBridge {
  constructor(profile) {
    this.proc = null
    this.ready = false
    this.profile = profile || 'balanced' // fast / balanced / accurate
    this.pending = new Map() // seq -> { resolve, reject }
    this.seq = 0
    this.onRefined = null // 两段式渐进：最终结果回调（msg => void）
    this._readyPromise = null
    this._readyResolve = null
    this._readyReject = null
  }

  _resolvePython() {
    // 打包后：优先使用 extraResources 里的 ocr_server 目录（onedir 结构）
    const exe = path.join(process.resourcesPath || '', 'ocr_server', 'ocr_server.exe')
    try {
      if (fs.existsSync(exe)) return { cmd: exe, args: [] }
    } catch { /* 资源目录不可读 → 走开发期路径 */ }

    // 开发期：优先环境变量指定的 python，否则用系统 python
    // SCREEN_OCR_SCRIPT 仅用于自动化测试（换成假 sidecar），生产环境不要设置
    const py = process.env.SCREEN_OCR_PYTHON || 'python'
    const script = process.env.SCREEN_OCR_SCRIPT || path.join(__dirname, '..', '..', 'python', 'ocr_server.py')
    return { cmd: py, args: [script] }
  }

  init() {
    if (this.proc && this.ready) return Promise.resolve()
    if (!this.proc) this._spawn()
    return this._waitReady()
  }

  _spawn() {
    const { cmd, args } = this._resolvePython()
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // 通过环境变量把识别档位传给 sidecar（balanced 为默认，速度/精度均衡）
      env: { ...process.env, SCREEN_OCR_PROFILE: this.profile }
    })
    this.proc = proc
    this.ready = false

    proc.stderr.on('data', (d) => console.error('[ocr:stderr]', String(d).trim()))
    proc.on('error', (e) => {
      console.error('[ocr] 启动失败：', e.message)
      if (this.proc === proc) this.proc = null
      this.ready = false
      this._failAll('E_OCR_SPAWN: ' + e.message)
    })
    proc.on('exit', (code) => {
      console.error('[ocr] 子进程退出，code =', code)
      if (this.proc === proc) this.proc = null
      this.ready = false
      this._failAll('E_OCR_EXITED')
    })

    let buf = ''
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) this._onLine(line)
      }
    })
  }

  // 进程不可用：让所有挂起请求与「等 ready」的调用都失败，避免永久等待
  _failAll(message) {
    for (const [, p] of this.pending) p.reject(new Error(message))
    this.pending.clear()
    if (this._readyReject) this._readyReject(new Error(message))
  }

  _onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return } // 非 JSON 行（第三方库日志）直接忽略

    // sidecar 的告警（例如「档位模型不可用，已回退 balanced」）不能静默吞掉，
    // 否则设置页显示「高精度」、引擎实际跑「均衡」，用户只会觉得"设置没生效"
    if (msg.type === 'warn') {
      console.warn('[ocr] 警告:', msg.message)
      return
    }

    if (msg.type === 'ready') {
      if (msg.profile) this.profile = msg.profile // 以引擎实际加载的档位为准（可能发生回退）
      this.ready = true
      if (this._readyResolve) this._readyResolve()
      return
    }

    // 档位切换回包：同样以引擎回报为准
    if (msg.type === 'profileChanged' && msg.profile) this.profile = msg.profile

    // 两段式渐进的第二阶段：临时结果已经回过包（pending 里没有 seq），
    // 这里走独立回调把「最终结果」推给上层，不能当成未知消息丢掉。
    if (msg.type === 'refined') {
      if (typeof this.onRefined === 'function') {
        try { this.onRefined(msg) } catch (e) { /* 回调异常不影响后续请求 */ }
      }
      return
    }

    const seq = msg.seq
    if (seq != null && this.pending.has(seq)) {
      const { resolve, reject } = this.pending.get(seq)
      this.pending.delete(seq)
      if (msg.type === 'error') reject(new Error(msg.message || 'E_OCR'))
      else resolve(msg)
    }
  }

  _waitReady(timeout = READY_TIMEOUT) {
    if (this.ready) return Promise.resolve()
    if (!this.proc) return Promise.reject(new Error('E_OCR_NOT_RUNNING'))
    if (this._readyPromise) return this._readyPromise

    this._readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('E_OCR_READY_TIMEOUT'))
      }, timeout)
      const cleanup = () => {
        clearTimeout(timer)
        this._readyPromise = null
        this._readyResolve = null
        this._readyReject = null
      }
      this._readyResolve = () => { cleanup(); resolve() }
      this._readyReject = (e) => { cleanup(); reject(e) }
    })
    return this._readyPromise
  }

  _send(msg, timeout = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        reject(new Error('E_OCR_NOT_RUNNING'))
        return
      }
      const seq = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error('E_OCR_TIMEOUT'))
      }, timeout)

      this.pending.set(seq, {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })

      try {
        this.proc.stdin.write(JSON.stringify({ ...msg, seq }) + '\n')
      } catch (e) {
        this.pending.delete(seq)
        clearTimeout(timer)
        reject(new Error('E_OCR_WRITE: ' + e.message))
      }
    })
  }

  /** 识别一张图片（base64，不带 dataURL 前缀），返回 { texts, boxes, scores, elapse_ms } */
  async recognizeBase64(b64) {
    if (typeof b64 !== 'string' || !b64.length) throw new Error('E_EMPTY_SELECTION')
    return this._recognize({ type: 'recognize', image: b64 })
  }

  /** 兼容旧调用：接受 Buffer */
  async recognize(imageBuffer) {
    if (!imageBuffer || !imageBuffer.length) throw new Error('E_EMPTY_SELECTION')
    return this.recognizeBase64(Buffer.from(imageBuffer).toString('base64'))
  }

  async _recognize(msg, retried) {
    try {
      await this.init()
      return await this._send(msg)
    } catch (e) {
      // 只在进程没了的时候重启重试一次；超时不重试
      if (!retried && RETRYABLE.test(String(e && e.message))) {
        this.reset()
        return this._recognize(msg, true)
      }
      throw e
    }
  }

  /** 丢弃当前进程（下次 init 会重新拉起） */
  reset() {
    const proc = this.proc
    this.proc = null
    this.ready = false
    this._failAll('E_OCR_EXITED')
    if (proc) {
      try { proc.kill() } catch { /* 已退出 */ }
    }
  }

  /** 运行时切换识别档位（fast / balanced / accurate），无需重启 sidecar */
  async setProfile(profile) {
    const p = String(profile || '').trim().toLowerCase()
    if (!['fast', 'balanced', 'accurate'].includes(p) || p === this.profile) return false
    if (!this.proc) { this.profile = p; return true } // 尚未启动：下次 init 会用新档位

    // 关键：只有引擎确认后才改 this.profile。
    // 先改后发一旦失败，会变成「本地记 balanced、引擎还跑 accurate」，
    // 之后再次保存又因 p === this.profile 直接跳过，永远切不回来。
    try {
      const res = await this._send({ type: 'setProfile', profile: p })
      if (res && res.profile) this.profile = res.profile
      return this.profile === p
    } catch {
      return false
    }
  }

  close() {
    const proc = this.proc
    this.proc = null
    this.ready = false
    this._failAll('E_OCR_CLOSED')
    if (proc) {
      try { proc.stdin.write(JSON.stringify({ type: 'exit' }) + '\n') } catch { /* 已退出 */ }
      // 留一点时间让 sidecar 自己退出，超时再强杀
      setTimeout(() => { try { proc.kill() } catch { /* 已退出 */ } }, 500)
    }
  }
}

module.exports = { OcrBridge }
