// 静态扫描：确认界面文案没有硬编码残留、且所有 i18n key 都存在于词典
// 运行：node test_i18n_scan.js
//
// 规则：
//   1. src/ 下所有 .js / .html（词典自身除外）去掉注释后，不得再出现中日韩字符；
//      日志调用（log.* / console.*）属于诊断信息，不面向界面，予以放行。
//   2. HTML 里的 data-i18n / data-i18n-title / data-i18n-placeholder 的 key 必须存在于词典。
//   3. JS 里 t('key') / tr('key') 形式的字面量 key 必须存在于词典。
const fs = require('fs')
const path = require('path')
const I18n = require('../src/shared/i18n')

const ROOT = path.join(__dirname, '..', 'src')
const DICT_FILE = path.join(ROOT, 'shared', 'i18n.js')
const LOG_IMPL = path.join(ROOT, 'main', 'log.js') // 日志实现本身，只有诊断文本
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const violations = []
const unknownKeys = []

// —— 去掉 JS 注释（保留字符串内容，避免误伤 URL 里的 //）——
function stripJsComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += d || ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') quote = c
    out += c
    i++
  }
  return out
}

const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

// 移除日志调用（可能跨多行）：日志是给开发者看的诊断信息，不参与界面文案检查
function stripLogCalls(src) {
  const re = /\b(?:log\.(?:info|warn|error|debug)|console\.(?:log|warn|error|info))\s*\(/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(src))) {
    const start = m.index
    let i = re.lastIndex
    let depth = 1
    let quote = null
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (quote) {
        if (c === '\\') { i += 2; continue }
        if (c === quote) quote = null
        i++
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue }
      if (c === '(') depth++
      else if (c === ')') depth--
      i++
    }
    out += src.slice(last, start) + '/*log*/'
    last = i
    re.lastIndex = i
  }
  return out + src.slice(last)
}

function walk(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (/\.(js|html)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(ROOT)
let scanned = 0

for (const file of files) {
  if (path.resolve(file) === path.resolve(DICT_FILE)) continue // 词典本身就是文案来源
  if (path.resolve(file) === path.resolve(LOG_IMPL)) continue // 日志实现只有诊断文本
  const rel = path.relative(path.join(__dirname, '..'), file)
  const raw = fs.readFileSync(file, 'utf8')
  const isHtml = file.endsWith('.html')
  const body = isHtml
    ? stripHtmlComments(raw)
    : stripLogCalls(stripJsComments(raw))
  const lines = body.split('\n')

  // 1) 中文字符残留（日志调用已在上面整体移除）
  lines.forEach((line, idx) => {
    if (!CJK.test(line)) return
    violations.push(rel + ':' + (idx + 1) + '  ' + line.trim())
  })

  // 2) HTML 静态 key 校验
  if (isHtml) {
    const re = /data-i18n(?:-title|-placeholder)?="([^"]+)"/g
    let m
    while ((m = re.exec(body))) {
      scanned++
      if (!(m[1] in I18n.MESSAGES.zh)) unknownKeys.push(rel + '  ' + m[1])
    }
  }

  // 3) JS 字面量 key 校验：t('x') / tr('x') / I18n.t(lang, 'x')
  const kre = /\b(?:tr|t)\(\s*'([a-z][A-Za-z0-9.]*)'/g
  let k
  while ((k = kre.exec(body))) {
    scanned++
    if (!(k[1] in I18n.MESSAGES.zh)) unknownKeys.push(rel + '  ' + k[1])
  }
}

console.log('扫描文件数:', files.length - 1, '| 校验的 i18n key 次数:', scanned)

if (violations.length) {
  console.log('\n[FAIL] 发现硬编码文案残留：')
  violations.forEach((v) => console.log('  ' + v))
} else {
  console.log('[OK] 未发现硬编码界面文案（日志/注释已排除）')
}

if (unknownKeys.length) {
  console.log('\n[FAIL] 引用了词典中不存在的 key：')
  unknownKeys.forEach((v) => console.log('  ' + v))
} else {
  console.log('[OK] 所有 data-i18n / t(...) key 均存在于词典')
}

const ok = violations.length === 0 && unknownKeys.length === 0
console.log('\n' + (ok ? '[ALL PASS] i18n 静态扫描通过' : '[FAIL] i18n 静态扫描未通过'))
process.exit(ok ? 0 : 1)
