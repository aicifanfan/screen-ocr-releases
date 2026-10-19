// 截图自检：验证多屏捕获 + 虚拟桌面计算 + 混合 DPI（每屏 scaleFactor）+ 屏标识字段
const { app } = require('electron')
const { captureAllScreens } = require('./src/main/screen-capture')

app.whenReady().then(async () => {
  try {
    const cap = await captureAllScreens()
    console.log('[OK] 显示器数量:', cap.displays.length)
    console.log('[OK] 虚拟桌面(DIP):', JSON.stringify(cap.virtual))
    console.log('[OK] primaryScaleFactor:', cap.primaryScaleFactor)
    for (const d of cap.displays) {
      console.log(
        '  - ' + (d.label || '?') +
        ' @(' + d.x + ',' + d.y + ') ' + d.width + 'x' + d.height +
        ' sf=' + d.scaleFactor + ' 物理=' + d.pxWidth + 'x' + d.pxHeight +
        ' isPrimary=' + d.isPrimary + ' [' + d.dataUrl.slice(0, 16) + '…] 长度 ' + d.dataUrl.length
      )
    }

    const basicOk =
      cap.displays.length >= 1 &&
      cap.virtual.width > 0 &&
      cap.virtual.height > 0 &&
      cap.primaryScaleFactor >= 1 &&
      // 优先 JPEG（性能优化）；兜底允许 PNG
      cap.displays.every((d) => typeof d.dataUrl === 'string' && /^data:image\/(jpeg|png)/.test(d.dataUrl))

    // 每屏独立 scaleFactor + 物理尺寸一致性
    const dpiOk = cap.displays.every((d) => {
      const expW = Math.round(d.width * d.scaleFactor)
      const expH = Math.round(d.height * d.scaleFactor)
      return d.scaleFactor >= 1 && d.pxWidth === expW && d.pxHeight === expH
    })

    const fieldOk = cap.displays.every(
      (d) => typeof d.id === 'string' && d.id.length > 0 &&
             typeof d.label === 'string' && d.label.length > 0 &&
             typeof d.isPrimary === 'boolean'
    )
    const primaryOk = cap.displays.filter((d) => d.isPrimary).length === 1

    const ok = basicOk && dpiOk && fieldOk && primaryOk
    console.log(ok ? '[PASS] 多屏捕获 + 混合 DPI 字段正确' : '[FAIL] 返回结构异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})

app.on('window-all-closed', () => app.quit())
