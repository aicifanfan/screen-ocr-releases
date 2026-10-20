// 档位表（src/shared/profiles.js）契约测试：
//   1. 唯一性与默认值
//   2. 非法输入归一化（手改坏配置 / 旧配置 / 大小写）
//   3. 与 settings.html 的下拉项一致（顺序、取值）
//   4. i18n 文案齐备（labelKey 在词典里存在）
const fs = require('fs')
const path = require('path')
const P = require('../src/shared/profiles')
const I18n = require('../src/shared/i18n')

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail !== undefined ? '  ' + detail : ''))
}

// 1) 基本契约
check('档位顺序固定为 fast → balanced → accurate', P.PROFILE_IDS.join(',') === 'fast,balanced,accurate', P.PROFILE_IDS.join(','))
check('默认档位是 balanced', P.DEFAULT_PROFILE === 'balanced', P.DEFAULT_PROFILE)
check('三个档位 id 不重复', new Set(P.PROFILE_IDS).size === P.PROFILE_IDS.length)
check('每个档位都有 labelKey 与 model', P.PROFILES.every((p) => p.labelKey && p.model && p.model.det && p.model.rec))

// 2) 归一化
check('非法值回落默认档', P.normalizeProfile('ultra') === 'balanced', P.normalizeProfile('ultra'))
check('空值回落默认档', P.normalizeProfile(null) === 'balanced')
check('大小写与空白被规整', P.normalizeProfile('  FAST ') === 'fast', P.normalizeProfile('  FAST '))
check('可指定兜底值', P.normalizeProfile('nope', 'accurate') === 'accurate')
check('isValidProfile 只认白名单', P.isValidProfile('fast') && !P.isValidProfile('fast2') && !P.isValidProfile(''))

// 3) 与设置页下拉一致
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8')
const selectBlock = (html.match(/<select[^>]*id="opt-ocr-profile"[\s\S]*?<\/select>/) || [''])[0]
const values = [...selectBlock.matchAll(/value="([^"]+)"/g)].map((m) => m[1])
check('设置页选项与档位表完全一致', JSON.stringify(values) === JSON.stringify(P.PROFILE_IDS), values.join(','))

// 4) 文案齐备（中英都要有）
for (const lang of ['zh', 'en']) {
  const missing = P.PROFILES.filter((p) => I18n.t(lang, p.labelKey) === p.labelKey).map((p) => p.labelKey)
  check('i18n[' + lang + '] 档位文案齐全', missing.length === 0, missing.join(',') || 'ok')
}

// 5) 顺序与 progressive 标记符合预期（accurate 才有精修）
check('只有 accurate 走两段式精修',
  P.PROFILES.filter((p) => p.progressive).map((p) => p.id).join(',') === 'accurate',
  P.PROFILES.map((p) => p.id + ':' + p.progressive).join(' '))

console.log(pass ? '[ALL PASS] 档位表契约通过' : '[FAIL] 存在未通过项')
process.exit(pass ? 0 : 1)
