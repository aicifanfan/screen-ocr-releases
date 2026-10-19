// 启动日志：写入 userData/startup.log（同步写，保证进程崩溃前也能落盘）
// 用途：双击无反应、遮罩不出现、GPU 崩溃等问题可事后取证。
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const MAX_BYTES = 512 * 1024 // 超过 512KB 滚动一份 .prev

let logPath = null
let inited = false

function init() {
  try {
    logPath = path.join(app.getPath('userData'), 'startup.log')
    try {
      const st = fs.statSync(logPath)
      if (st.size > MAX_BYTES) fs.renameSync(logPath, logPath + '.prev')
    } catch { /* 文件不存在则忽略 */ }
    inited = true
    write('INFO', '===== 启动 v' + app.getVersion() + ' (electron ' + process.versions.electron + ') =====')
    write('INFO', '平台: ' + process.platform + ' ' + process.arch + ' | packaged=' + app.isPackaged)
  } catch (e) {
    // 日志不可写时不影响主流程
    console.error('[log] 初始化失败:', e && e.message)
  }
}

function write(level, msg) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + msg + '\n'
  if (inited && logPath) {
    try { fs.appendFileSync(logPath, line) } catch { /* 忽略写失败 */ }
  }
  try {
    if (level === 'ERROR') console.error('[log]', msg)
    else console.log('[log]', msg)
  } catch { /* 忽略 */ }
}

module.exports = {
  init,
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  path: () => logPath
}
