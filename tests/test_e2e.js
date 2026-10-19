// Step 5 端到端自检：多屏截图 → 裁剪（模拟渲染进程选区）→ OCR
const { app, nativeImage } = require('electron')
const { captureAllScreens } = require('../src/main/screen-capture')
const { OcrBridge } = require('../src/main/ocr-bridge')

app.disableHardwareAcceleration() // 禁用 GPU，避免无 GPU 环境崩溃
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

app.whenReady().then(async () => {
  const ocr = new OcrBridge()
  try {
    const cap = await captureAllScreens()
    console.log('[OK] 显示器数量:', cap.displays.length)
    console.log('[OK] 虚拟桌面:', JSON.stringify(cap.virtual))
    console.log('[OK] primaryScaleFactor:', cap.primaryScaleFactor)

    const d0 = cap.displays[0]
    const img = nativeImage.createFromDataURL(d0.dataUrl)
    console.log('[OK] 显示器0 物理尺寸:', img.getSize().width, 'x', img.getSize().height)

    // 模拟框选中间一块区域（DIP 坐标 → 用该屏 scaleFactor 换算物理坐标裁剪）
    const rect = {
      x: Math.floor(d0.width / 4),
      y: Math.floor(d0.height / 4),
      width: Math.floor(d0.width / 2),
      height: Math.floor(d0.height / 2)
    }
    const cropped = img.crop({
      x: Math.round(rect.x * d0.scaleFactor),
      y: Math.round(rect.y * d0.scaleFactor),
      width: Math.round(rect.width * d0.scaleFactor),
      height: Math.round(rect.height * d0.scaleFactor)
    })
    console.log('[OK] 裁剪(物理):', cropped.getSize().width, 'x', cropped.getSize().height)

    console.log('[..] OCR 识别中（含子进程启动与模型预热）...')
    const result = await ocr.recognize(cropped.toPNG())
    console.log('[OK] 返回类型:', result.type)
    console.log('[OK] texts 数量:', result.texts ? result.texts.length : 0)
    console.log('[OK] texts 内容:', JSON.stringify(result.texts))

    const ok = result.type === 'result' && Array.isArray(result.texts) && Array.isArray(result.boxes)
    console.log(ok ? '[PASS] 端到端链路（多屏截图→裁剪→OCR→JSON）正常' : '[FAIL] 返回结构异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    ocr.close()
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
