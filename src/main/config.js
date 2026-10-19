// 配置模块：读写 userData/settings.json，提供默认值
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

// 配置结构版本：用于一次性迁移旧配置
// v2：取消「启动时自动截屏」的默认行为（程序启动后必须由用户主动触发才截屏）
const CONFIG_VERSION = 2

const DEFAULTS = {
  shortcut: 'CommandOrControl+Shift+A', // 截图快捷键（Electron accelerator）
  autoLaunch: false,                    // 开机自启
  captureOnLaunch: false,               // 启动时立即截屏（默认关闭：必须用户主动触发）
  autoCloseAfterCopy: true,             // 复制后自动关闭结果窗口
  autoCheckUpdate: true,                // 启动时自动检查更新
  ocrProfile: 'balanced',               // OCR 档位：fast(最快) / balanced(均衡,默认) / accurate(最准)
  disableGpu: true,                     // 兼容模式（默认开启）：关闭 GPU 加速，保证启动稳定；
                                        // 关闭此项即启用 GPU 硬件加速（拖拽更流畅，但个别显卡驱动可能崩溃）
  language: 'auto'                      // 界面语言：auto(跟随系统) / zh / en；非法值按 auto 处理
}

let cache = null

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8')
  } catch (e) {
    console.error('[config] 保存失败：', e.message)
  }
}

function load() {
  if (cache) return cache
  let parsed = {}
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {}
  } catch {
    parsed = {}
  }
  cache = Object.assign({}, DEFAULTS, parsed)

  // 一次性迁移：老版本默认「启动即截屏」为 true，v2 起强制关闭，
  // 避免程序一启动就自动弹出截屏遮罩。
  if (parsed.__v !== CONFIG_VERSION) {
    cache.captureOnLaunch = false
    cache.__v = CONFIG_VERSION
    persist()
  }
  return cache
}

function getAll() { return load() }

function get(key) { return load()[key] }

function set(key, val) {
  load()[key] = val
  persist()
  return val
}

function update(partial) {
  Object.assign(load(), partial)
  persist()
  return load()
}

module.exports = { DEFAULTS, getAll, get, set, update }
