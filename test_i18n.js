// i18n 词典与解析逻辑单测（纯 Node，无需 Electron）
// 运行：node test_i18n.js
const I18n = require('./src/shared/i18n')

let failed = 0
function check(name, cond, detail) {
  if (cond) {
    console.log('  [OK]   ' + name)
  } else {
    failed++
    console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : ''))
  }
}

const zh = I18n.MESSAGES.zh
const en = I18n.MESSAGES.en
const zhKeys = Object.keys(zh)
const enKeys = Object.keys(en)

console.log('\n== 1. 词典完整性 ==')
check('中英 key 数量一致 (' + zhKeys.length + ')', zhKeys.length === enKeys.length,
  'zh=' + zhKeys.length + ' en=' + enKeys.length)
const onlyZh = zhKeys.filter((k) => !(k in en))
const onlyEn = enKeys.filter((k) => !(k in zh))
check('中文有而英文缺失的 key', onlyZh.length === 0, onlyZh.join(', '))
check('英文有而中文缺失的 key', onlyEn.length === 0, onlyEn.join(', '))

console.log('\n== 2. 文案非空 ==')
const emptyVals = zhKeys.filter((k) => !String(zh[k]).trim() || !String(en[k] !== undefined ? en[k] : '').trim())
check('两种语言均无空文案', emptyVals.length === 0, emptyVals.join(', '))

console.log('\n== 3. 占位符一致性 ==')
const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(',')
const badPh = zhKeys.filter((k) => k in en && ph(zh[k]) !== ph(en[k]))
  .map((k) => k + ' zh=' + ph(zh[k]) + ' en=' + ph(en[k]))
check('同一 key 的占位符集合一致', badPh.length === 0, badPh.join(' | '))

// 允许中英同形的 key（专有名词/语言名）
const SAME_OK = new Set(['settings.language.zh', 'settings.language.en', 'common.notSet'])
const suspicious = zhKeys.filter((k) => !SAME_OK.has(k) && zh[k] === en[k])
check('没有「中英完全相同」的可疑漏译', suspicious.length === 0, suspicious.join(', '))

console.log('\n== 4. 语言归一化 ==')
const cases = [
  ['zh', 'zh'], ['zh-CN', 'zh'], ['zh-Hans-CN', 'zh'], ['ZH_cn', 'zh'],
  ['en', 'en'], ['en-US', 'en'], ['en-GB', 'en'],
  ['xx', 'zh'], ['', 'zh'], [null, 'zh'], [undefined, 'zh']
]
let normOk = true
for (const [input, expect] of cases) {
  const got = I18n.normalizeLang(input)
  if (got !== expect) { normOk = false; console.log('    ✗ ' + JSON.stringify(input) + ' → ' + got + '（期望 ' + expect + '）') }
}
check('normalizeLang 别名/非法值回退', normOk)

console.log('\n== 5. 设置项解析（auto → 系统 → 默认）==')
check('auto + zh-CN → zh', I18n.resolveLang('auto', 'zh-CN') === 'zh')
check('auto + en-US → en', I18n.resolveLang('auto', 'en-US') === 'en')
check('auto + 未知系统语言 → 默认 zh', I18n.resolveLang('auto', 'fr-FR') === 'zh')
check('显式 en 覆盖系统 zh', I18n.resolveLang('en', 'zh-CN') === 'en')
check('显式 zh 覆盖系统 en', I18n.resolveLang('zh', 'en-US') === 'zh')
check('非法设置值按 auto 处理', I18n.resolveLang('klingon', 'en-US') === 'en')
check('设置值大小写/空格容错', I18n.resolveLang(' EN ', 'zh-CN') === 'en')

console.log('\n== 6. 取词与回退 ==')
check('正常取词', I18n.t('en', 'settings.save') === 'Save')
check('占位符插值', I18n.t('en', 'tray.capture', { shortcut: 'Ctrl+A' }) === 'Capture Text (Ctrl+A)')
check('缺参数时保留占位符', I18n.t('en', 'tray.capture').includes('{shortcut}'))
check('未知 key 原样返回（中文环境）', I18n.t('zh', 'no.such.key') === 'no.such.key')
check('未知语言回退到默认语言', I18n.t('fr', 'settings.save') === '保存')

console.log('\n== 7. 字典结构 ==')
check('LANGS 仅含 zh/en', I18n.LANGS.join(',') === 'zh,en')
check('DEFAULT_LANG 为 zh', I18n.DEFAULT_LANG === 'zh')
check('messages() 返回同一份词典', I18n.messages().zh === zh)

console.log('\n' + (failed === 0 ? '[ALL PASS] i18n 词典与解析逻辑全部通过' : '[FAIL] 共 ' + failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
