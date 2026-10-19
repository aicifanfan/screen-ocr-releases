// 快捷键 accelerator 工具（纯函数，无 DOM，可在浏览器与 Node 中共用以便单测）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.Accelerator = factory()
})(typeof self !== 'undefined' ? self : this, function () {

  // 键盘事件 → Electron accelerator 字符串；非法组合返回 null
  function keyEventToAccelerator(e) {
    const mods = []
    if (e.metaKey) mods.push('Super')       // Windows 键 / macOS Command
    if (e.ctrlKey) mods.push('CommandOrControl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')

    let key = e.key
    if (key === ' ') key = 'Space'
    else if (/^F\d{1,2}$/i.test(key)) key = key.toUpperCase() // F1~F24
    else if (key === 'ArrowUp') key = 'Up'
    else if (key === 'ArrowDown') key = 'Down'
    else if (key === 'ArrowLeft') key = 'Left'
    else if (key === 'ArrowRight') key = 'Right'
    else if (key === 'Enter') key = 'Return'
    else if (['Backspace', 'Delete', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'CapsLock'].includes(key)) key = key
    else if (key === 'Escape') return null
    else if (key.length === 1) key = key.toUpperCase() // 字母 / 数字 / 符号
    else return null // 忽略单独修饰键、Shift 等

    // 至少一个修饰键，避免与普通输入冲突
    if (!mods.length) return null
    return mods.join('+') + '+' + key
  }

  // accelerator → 可读显示（CommandOrControl/Control → Ctrl，Super → Win）
  function acceleratorToDisplay(acc) {
    if (!acc) return ''
    return String(acc)
      .replace(/CommandOrControl/gi, 'Ctrl')
      .replace(/Control/gi, 'Ctrl')
      .replace(/Super/gi, 'Win')
      .split('+')
      .join(' + ')
  }

  return { keyEventToAccelerator, acceleratorToDisplay }
})
