// OCR 桥接端到端测试：Node → spawn 打包后的 ocr_server.exe → 识别结果
// 运行：node test_ocr_bridge.js
const fs = require('fs')
const path = require('path')
const { OcrBridge } = require('./src/main/ocr-bridge')

// 指向安装目录的打包产物（模拟 process.resourcesPath）
process.resourcesPath = 'C:/Users/Lenovo/AppData/Local/Programs/screen-ocr/resources'

const IMG = path.join(__dirname, 'python', 'bench_images', 'cn_small_15.png')
const IMG2 = path.join(__dirname, 'python', 'bench_images', 'symbols_18.png')

async function main() {
  if (!fs.existsSync(IMG)) { console.log('[FAIL] 测试图片不存在:', IMG); process.exit(1) }

  const bridge = new OcrBridge('balanced')
  const t0 = Date.now()
  const r1 = await bridge.recognize(fs.readFileSync(IMG))
  const cold = Date.now() - t0
  console.log('[OK] 首次识别（含启动）%dms | 引擎 %sms | 档位 %s', cold, r1.elapse_ms, r1.profile)
  console.log('     texts:', JSON.stringify(r1.texts))

  const t1 = Date.now()
  const r2 = await bridge.recognize(fs.readFileSync(IMG2))
  const warm = Date.now() - t1
  console.log('[OK] 二次识别 %dms | 引擎 %sms', warm, r2.elapse_ms)
  console.log('     texts:', JSON.stringify(r2.texts))

  // 档位切换
  const switched = await bridge.setProfile('fast')
  const t2 = Date.now()
  const r3 = await bridge.recognize(fs.readFileSync(IMG))
  console.log('[OK] 切换 fast=%s | 识别 %dms | 档位 %s', switched, Date.now() - t2, r3.profile)

  const ok = r1.texts.length > 0 && r1.elapse_ms > 0 && r2.texts.length > 0 &&
    warm < cold && switched === true
  console.log(ok ? '[PASS] OCR 桥接端到端正常（打包 exe + 档位切换）' : '[FAIL] 桥接异常')
  if (!ok) process.exitCode = 1
  bridge.close()
  setTimeout(() => process.exit(process.exitCode || 0), 500)
}

main().catch((e) => { console.error('[FAIL]', e); process.exit(1) })
