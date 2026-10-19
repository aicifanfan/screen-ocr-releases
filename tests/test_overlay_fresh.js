// 每次截屏都是全新窗口 + 关闭后彻底销毁（回归：不允许窗口复用导致多层嵌套）
// ① 每次截屏新建窗口：第二次的窗口 id 与第一次完全不同
// ② 关闭后窗口被真正销毁（不是 hide），不残留、不参与下次
// ③ 每次遮罩窗口数 == 屏数，不会随次数累加（无嵌套/叠加）
const { app, BrowserWindow, screen } = require('electron')

process.env.SCREEN_OCR_PYTHON =
  'C:/Users/Lenovo/.workbuddy/binaries/python/envs/ocr/Scripts/python.exe'

// 独立 userData：避免与其它测试/安装版实例抢单实例锁（否则会静默退出、无输出）
app.setPath('userData', require('path').join(app.getPath('appData'), 'screen-ocr-test-fresh'))

require('../src/main/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pickOverlays = () =>
  BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('overlay'))

async function triggerAndWait() {
  app.emit('second-instance') // 等价于用户按快捷键 / 再次双击图标
  let overlays = []
  for (let i = 0; i < 60 && !overlays.length; i++) {
    await sleep(150)
    overlays = pickOverlays().filter((w) => w.isVisible())
  }
  await sleep(500) // 等截图填充稳定
  return pickOverlays()
}

app.whenReady().then(async () => {
  try {
    const displayCount = screen.getAllDisplays().length

    // —— 第一次截屏 ——
    const first = await triggerAndWait()
    if (!first.length) { console.log('[FAIL] 首次遮罩未出现'); app.quit(); return }
    const firstIds = first.map((w) => w.id).sort()
    console.log('[OK] 第一次遮罩窗口 ids:', JSON.stringify(firstIds), '屏数:', displayCount)

    const countOk1 = first.length === displayCount
    console.log(countOk1 ? '[PASS] 第一次窗口数 = 屏数' : '[WARN] 第一次窗口数(' + first.length + ') != 屏数(' + displayCount + ')')

    // —— 关闭（走真实 IPC，等价 Esc / 识别完成）——
    // 注意：closeOverlay 会销毁窗口自身，渲染进程随之消失，因此不能 await 其结果
    first[0].webContents.executeJavaScript('window.api.closeOverlay()').catch(() => {})
    await sleep(900)

    const afterClose = pickOverlays()
    const aliveAfterClose = afterClose.filter((w) => !w.isDestroyed()).length
    console.log('[OK] 关闭后 overlay 窗口实例:', afterClose.length, '| 未销毁:', aliveAfterClose)
    const destroyedOk = afterClose.length === 0 || aliveAfterClose === 0
    console.log(destroyedOk ? '[PASS] 关闭后窗口已彻底销毁（非 hide）' : '[FAIL] 窗口仍存活（会被复用 → 叠加）')

    // —— 第二次截屏 ——
    const second = await triggerAndWait()
    if (!second.length) { console.log('[FAIL] 第二次遮罩未出现'); app.quit(); return }
    const secondIds = second.map((w) => w.id).sort()
    console.log('[OK] 第二次遮罩窗口 ids:', JSON.stringify(secondIds))

    const freshOk =
      secondIds.length === firstIds.length &&
      secondIds.every((id) => !firstIds.includes(id))
    console.log(freshOk ? '[PASS] 第二次使用全新窗口（无复用）' : '[FAIL] 窗口 id 重复 → 发生了复用')

    const countOk2 = second.length === displayCount
    console.log(countOk2 ? '[PASS] 第二次窗口数 = 屏数（无累加/嵌套）' : '[FAIL] 窗口数异常(' + second.length + ')')

    const ok = countOk1 && destroyedOk && freshOk && countOk2
    console.log(ok ? '[ALL PASS] 每次截屏均为独立干净窗口' : '[FAIL] 存在复用/残留/嵌套')
    if (!ok) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 300)
  }
})
