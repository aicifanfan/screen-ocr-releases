// JPEG 优化专项验证（不依赖 BrowserWindow，直接用 nativeImage 解码）：
// ① captureAllScreens 返回 JPEG dataUrl
// ② 该 JPEG 可被解码，且像素非空（确认不是坏图）
// ③ 量化 PNG(toDataURL) vs JPEG(toJPEG) 的编码耗时与体积差异
const { app, nativeImage, desktopCapturer, screen } = require('electron')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

app.whenReady().then(async () => {
  try {
    const { captureAllScreens } = require('./src/main/screen-capture')
    const cap = await captureAllScreens()
    const d = cap.displays[0]
    console.log('[OK] 捕获屏数:', cap.displays.length)

    const jpegOk = /^data:image\/jpeg/.test(d.dataUrl)

    // 用 nativeImage 解码 JPEG dataUrl，验证图像有效
    const img = nativeImage.createFromDataURL(d.dataUrl)
    const size = img.getSize()
    const bmp = img.toBitmap() // BGRA
    let nonZero = 0
    for (let i = 0; i < bmp.length; i += 4) {
      if (bmp[i] || bmp[i + 1] || bmp[i + 2]) nonZero++
    }
    const totalPx = bmp.length / 4
    const nonZeroRatio = totalPx ? nonZero / totalPx : 0
    const decodeOk = !img.isEmpty() && size.width > 0 && size.height > 0 && nonZeroRatio > 0.1
    console.log('[OK] JPEG 解码: ' + size.width + 'x' + size.height + ', 非空像素比例=' + nonZeroRatio.toFixed(2))

    // 量化对比：同一块屏，PNG vs JPEG 编码耗时与体积
    const displays = screen.getAllDisplays()
    const maxW = Math.max(...displays.map((x) => Math.round(x.bounds.width * (x.scaleFactor || 1))))
    const maxH = Math.max(...displays.map((x) => Math.round(x.bounds.height * (x.scaleFactor || 1))))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } })
    const thumb = sources[0].thumbnail

    let t = Date.now()
    const pngUrl = thumb.toDataURL()
    const pngMs = Date.now() - t
    const pngBytes = Math.round((pngUrl.length - 'data:image/png;base64,'.length) * 0.75)

    t = Date.now()
    const jpegBuf = thumb.toJPEG(92)
    const jpegMs = Date.now() - t
    const jpegBytes = jpegBuf.length

    console.log('[BENCH] PNG : ' + pngMs + 'ms, ' + (pngBytes / 1024).toFixed(0) + ' KB')
    console.log('[BENCH] JPEG: ' + jpegMs + 'ms, ' + (jpegBytes / 1024).toFixed(0) + ' KB')
    console.log('[BENCH] 编码加速 ' + (pngMs / Math.max(jpegMs, 1)).toFixed(1) + 'x, 体积缩小 ' + (pngBytes / jpegBytes).toFixed(1) + 'x')

    const ok = jpegOk && decodeOk
    console.log(ok ? '[PASS] JPEG 捕获 → 解码 → 像素有效' : '[FAIL] JPEG 链路异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
app.on('window-all-closed', () => app.quit())
