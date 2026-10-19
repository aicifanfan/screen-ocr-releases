// 托盘图标修复测试：验证 tray.png/tray16.png 可加载、Tray 创建成功且图标非空
const { app, nativeImage } = require('electron')
const path = require('path')
const { createTray } = require('./src/main/tray')

app.whenReady().then(() => {
  try {
    const icon16 = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'tray16.png'))
    const icon32 = nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'tray.png'))
    console.log('[OK] tray16 非空:', !icon16.isEmpty(), '尺寸', JSON.stringify(icon16.getSize()))
    console.log('[OK] tray   非空:', !icon32.isEmpty(), '尺寸', JSON.stringify(icon32.getSize()))

    const tray = createTray({ onCapture: () => {}, onQuit: () => {} })
    console.log('[OK] Tray 对象创建成功:', !!tray)
    // Tray 无 getImage()；图标非空已由上面的 nativeImage 校验覆盖（createTray 用它创建托盘）
    const ok = !icon16.isEmpty() && !icon32.isEmpty() && !!tray
    console.log(ok ? '[PASS] 托盘图标修复验证通过' : '[FAIL] 托盘图标异常')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 100)
  }
})
