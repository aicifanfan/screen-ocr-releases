// 纯逻辑单测：快捷键 accelerator 生成与显示（无需 GUI，普通 Node 即可运行）
// 运行：node test_accelerator.js
const { keyEventToAccelerator, acceleratorToDisplay } = require('./src/renderer/accelerator.js')

let fails = 0
function eq(name, actual, expect) {
  if (actual === expect) console.log('[PASS]', name, '=>', expect)
  else { console.log('[FAIL]', name, '=> got', JSON.stringify(actual), 'expect', JSON.stringify(expect)); fails++ }
}

function ev(key, mods = {}) {
  return { key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta }
}

// 常见组合
eq('Ctrl+Shift+A', keyEventToAccelerator(ev('a', { ctrl: true, shift: true })), 'CommandOrControl+Shift+A')
eq('Ctrl+A', keyEventToAccelerator(ev('a', { ctrl: true })), 'CommandOrControl+A')
eq('Ctrl+Alt+S', keyEventToAccelerator(ev('s', { ctrl: true, alt: true })), 'CommandOrControl+Alt+S')
eq('Ctrl+Shift+Alt+X', keyEventToAccelerator(ev('x', { ctrl: true, shift: true, alt: true })), 'CommandOrControl+Alt+Shift+X')
eq('Ctrl+1', keyEventToAccelerator(ev('1', { ctrl: true })), 'CommandOrControl+1')
eq('Win+Shift+S', keyEventToAccelerator(ev('s', { meta: true, shift: true })), 'Super+Shift+S')

// 功能键与特殊键
eq('Ctrl+F1', keyEventToAccelerator(ev('F1', { ctrl: true })), 'CommandOrControl+F1')
eq('Ctrl+F12', keyEventToAccelerator(ev('F12', { ctrl: true })), 'CommandOrControl+F12')
eq('Alt+Space', keyEventToAccelerator(ev(' ', { alt: true })), 'Alt+Space')
eq('Ctrl+方向键Up', keyEventToAccelerator(ev('ArrowUp', { ctrl: true })), 'CommandOrControl+Up')
eq('Ctrl+Delete', keyEventToAccelerator(ev('Delete', { ctrl: true })), 'CommandOrControl+Delete')
eq('Ctrl+Backspace', keyEventToAccelerator(ev('Backspace', { ctrl: true })), 'CommandOrControl+Backspace')

// 非法：无修饰键 / 单独修饰键 / Esc
eq('无修饰键字母', keyEventToAccelerator(ev('a')), null)
eq('单独 Ctrl', keyEventToAccelerator(ev('Control', { ctrl: true })), null)
eq('单独 Shift', keyEventToAccelerator(ev('Shift', { shift: true })), null)
eq('Esc', keyEventToAccelerator(ev('Escape', { ctrl: true })), null)

// 显示转换
eq('显示 Ctrl+Shift+A', acceleratorToDisplay('CommandOrControl+Shift+A'), 'Ctrl + Shift + A')
eq('显示 Super', acceleratorToDisplay('Super+Shift+S'), 'Win + Shift + S')
eq('显示 Control 别名', acceleratorToDisplay('Control+Alt+1'), 'Ctrl + Alt + 1')
eq('空字符串', acceleratorToDisplay(''), '')

console.log(fails === 0 ? '\n[ALL PASS]' : '\n[' + fails + ' FAILED]')
process.exit(fails === 0 ? 0 : 1)
