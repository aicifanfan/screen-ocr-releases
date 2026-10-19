// 配置模块：读写 userData/settings.json，提供默认值
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  shortcut: 'CommandOrControl+Shift+A', // 截图快捷键（Electron accelerator）
  autoLaunch: false,                    // 开机自启
  captureOnLaunch: true,                // 启动时立即截屏
  autoCloseAfterCopy: true,             // 复制后自动关闭结果窗口
  autoCheckUpdate: true                 // 启动时自动检查更新
}

let cache = null

function configPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function load() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    cache = Object.assign({}, DEFAULTS, JSON.parse(raw))
  } catch {
    cache = Object.assign({}, DEFAULTS)
  }
  return cache
}

function save() {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(load(), null, 2), 'utf8')
  } catch (e) {
    console.error('[config] 保存失败：', e.message)
  }
}

function getAll() { return load() }

function get(key) { return load()[key] }

function set(key, val) {
  load()[key] = val
  save()
  return val
}

function update(partial) {
  Object.assign(load(), partial)
  save()
  return load()
}

module.exports = { DEFAULTS, getAll, get, set, update }
