// 启动冒烟：真实拉起 Electron 主进程，验证「模块能加载、能拿到单实例锁、无未捕获异常」。
// 背景：0.3.0 因为在 `const ocr` 之前给 `ocr.onRefined` 赋值，模块加载期踩 TDZ，
// 双击完全没反应；而 test_launch.js 只 require 子模块、不加载入口，漏掉了这类问题。
//
// 判定方式：读 %APPDATA%/screen-ocr/startup.log 的新增行，出现
//   「whenReady: 主实例已获得锁」= 启动成功
//   「uncaughtException」/「Cannot access」= 启动失败
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
// electron 包在 Node 下 require 出来就是可执行文件路径；用 .cmd 直接 spawn 在 Windows 上会 EINVAL
const ELECTRON = require('electron')
const LOG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'screen-ocr', 'startup.log')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 按时间戳过滤而不是按行号：日志可能在启动时滚动（.prev），行号会错位
function readSince(sinceIso) {
  try {
    return fs.readFileSync(LOG, 'utf8').split('\n')
      .filter((l) => l.startsWith('[') && l.slice(1, 25) >= sinceIso)
  } catch { return [] }
}

;(async () => {
  if (!fs.existsSync(LOG)) {
    console.log('[SKIP] 还没有 startup.log，先手动启动一次应用再跑')
    process.exit(0)
  }
  const since = new Date(Date.now() - 1000).toISOString()

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则会被当成 node 跑
  const child = spawn(ELECTRON, ['.', '--no-sandbox'], { cwd: ROOT, env, stdio: 'ignore' })

  let lines = []
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    lines = readSince(since)
    if (lines.some((l) => l.includes('主实例已获得锁'))) break
    if (lines.some((l) => l.includes('非主实例'))) break
    await sleep(250)
  }
  await sleep(600) // 再等一会儿，让启动期异常有机会写进日志
  lines = readSince(since)
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) } catch { /* 已退出 */ }

  const text = lines.join('\n')
  const gotLock = lines.some((l) => l.includes('主实例已获得锁'))
  const otherInstance = lines.some((l) => l.includes('非主实例'))
  const crash = /uncaughtException|Cannot access '[^']+' before initialization/.test(text)
  const crashLine = lines.find((l) => /uncaughtException|Cannot access '.*' before initialization/.test(l)) || ''

  let pass = true
  const check = (name, ok, detail) => {
    if (!ok) pass = false
    console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''))
  }

  if (otherInstance) {
    console.log('[SKIP] 已有实例在运行（会拿到单实例锁并退出）。请先退出已安装的「截屏OCR」再跑本测试。')
    process.exit(0)
  }

  check('主进程获得单实例锁（模块加载完成）', gotLock)
  check('启动期无未捕获异常（TDZ / 初始化顺序）', !crash, crashLine.slice(0, 120))
  check('日志出现启动版本行', lines.some((l) => l.includes('===== 启动 v')), '')

  console.log(pass ? '[ALL PASS] 启动冒烟通过' : '[FAIL] 启动冒烟失败（双击可能无反应）')
  process.exit(pass ? 0 : 1)
})()
