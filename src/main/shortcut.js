// 全局快捷键：从配置读取，支持热更新重新注册
const { globalShortcut } = require('electron')
const { get } = require('./config')

// 注册截图快捷键。accelerator 缺省时从配置读取。
// 返回 { ok, accelerator }：ok=false 表示被其他程序占用。
function registerShortcuts(handlers, accelerator) {
  const acc = accelerator || get('shortcut')
  let ok = false
  try {
    ok = globalShortcut.register(acc, handlers.onCapture)
  } catch (e) {
    console.error('[shortcut] 注册异常：', e.message)
  }
  if (!ok) console.warn('[shortcut] 快捷键注册失败，可能被其他程序占用：', acc)
  return { ok, accelerator: acc }
}

// 更换快捷键：先注销全部，注册新的；失败则回滚旧快捷键
function updateShortcut(handlers, newAccelerator) {
  const old = get('shortcut')
  globalShortcut.unregisterAll()
  const r = registerShortcuts(handlers, newAccelerator)
  if (!r.ok && old && old !== newAccelerator) {
    console.warn('[shortcut] 新快捷键注册失败，回滚到：', old)
    registerShortcuts(handlers, old)
  }
  return r
}

function unregisterAll() {
  globalShortcut.unregisterAll()
}

module.exports = { registerShortcuts, updateShortcut, unregisterAll }
