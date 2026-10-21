// 推理设备表（src/shared/devices.js）契约测试：
//   1. 归一化与默认值
//   2. 设置页下拉与 UI_DEVICES 一致
//   3. i18n 文案齐备（中英）
const fs = require('fs')
const path = require('path')
const D = require('../src/shared/devices')
const I18n = require('../src/shared/i18n')

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail !== undefined ? '  ' + detail : ''))
}

check('默认设备是 auto', D.DEFAULT_DEVICE === 'auto', D.DEFAULT_DEVICE)
check('设备白名单含 auto/cpu/dml/cuda', D.DEVICES.join(',') === 'auto,cpu,dml,cuda', D.DEVICES.join(','))
check('界面只暴露 auto/cpu（dml/cuda 留给环境变量）', D.UI_DEVICES.map((d) => d.id).join(',') === 'auto,cpu')
check('非法值回落 auto', D.normalizeDevice('gpu') === 'auto', D.normalizeDevice('gpu'))
check('大小写与空白被规整', D.normalizeDevice('  CPU ') === 'cpu', D.normalizeDevice('  CPU '))
check('可指定兜底值', D.normalizeDevice('nope', 'cpu') === 'cpu')
check('isValidDevice 只认白名单', D.isValidDevice('dml') && !D.isValidDevice('tensorrt') && !D.isValidDevice(''))

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8')
const block = (html.match(/<select[^>]*id="opt-device"[\s\S]*?<\/select>/) || [''])[0]
const values = [...block.matchAll(/value="([^"]+)"/g)].map((m) => m[1])
check('设置页设备下拉与 UI_DEVICES 一致', JSON.stringify(values) === JSON.stringify(D.UI_DEVICES.map((d) => d.id)), values.join(','))

for (const lang of ['zh', 'en']) {
  const missing = D.UI_DEVICES.filter((d) => I18n.t(lang, d.labelKey) === d.labelKey).map((d) => d.labelKey)
  const desc = I18n.t(lang, 'settings.device.desc')
  check('i18n[' + lang + '] 设备文案齐全', missing.length === 0 && desc !== 'settings.device.desc', missing.join(',') || 'ok')
}

console.log(pass ? '[ALL PASS] 推理设备表契约通过' : '[FAIL] 存在未通过项')
process.exit(pass ? 0 : 1)
