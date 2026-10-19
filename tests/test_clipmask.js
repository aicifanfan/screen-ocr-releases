// clip-path 单遮罩挖洞验证：
// ① CLIP_OK 特性检测通过
// ② fullMask → clip-path:none，4 个 legacy 遮罩隐藏
// ③ renderSelection → polygon(evenodd) 坐标正确
// ④ elementFromPoint：选区中心不命中遮罩（洞），选区外命中遮罩
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')
const OVERLAY = path.join(__dirname, '..', 'src', 'renderer', 'overlay.html')

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false, width: 800, height: 600,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
    })
    await win.loadFile(OVERLAY)

    const red = await win.webContents.executeJavaScript(`(function(){
      const cv=document.createElement('canvas'); cv.width=800; cv.height=600;
      const x=cv.getContext('2d'); x.fillStyle='#ff0000'; x.fillRect(0,0,800,600);
      return cv.toDataURL('image/png');
    })()`)

    win.webContents.send('overlay:screens', {
      displays: [{ dataUrl: red, physX: 0, physY: 0, pxWidth: 800, pxHeight: 600, label: '主屏', isPrimary: true }],
      physVirtual: { x: 0, y: 0, width: 800, height: 600 },
      myIndex: 0
    })

    // 等 canvas 渲染
    for (let i = 0; i < 60; i++) {
      const n = await win.webContents.executeJavaScript(`document.querySelectorAll('#screens canvas').length`)
      if (n > 0) break
      await new Promise((r) => setTimeout(r, 100))
    }

    const r = await win.webContents.executeJavaScript(`(function(){
      const clipOk = CLIP_OK;
      // fullMask
      fullMask();
      const mh = document.getElementById('mask');
      const full = { clip: mh.style.clipPath, display: mh.style.display,
        legacyHidden: ['mask-top','mask-bottom','mask-left','mask-right'].every(id => document.getElementById(id).style.display === 'none') };
      // renderSelection 选区 100,100 200x150
      renderSelection({ x: 100, y: 100, width: 200, height: 150 });
      const sel = { clip: mh.style.clipPath, display: mh.style.display };
      // elementFromPoint
      const inHole = document.elementFromPoint(200, 175); // 选区中心
      const outside = document.elementFromPoint(30, 30);   // 选区外
      return { clipOk, full, sel, inHoleId: inHole && inHole.id, outsideId: outside && outside.id };
    })()`)

    console.log('[OK] CLIP_OK:', r.clipOk)
    console.log('[OK] fullMask clip:', r.full.clip, '| legacy hidden:', r.full.legacyHidden)
    console.log('[OK] selection clip 含 polygon(evenodd:', /polygon\(evenodd/.test(r.sel.clip), '| 含 100px 100px:', r.sel.clip.includes('100px 100px'))
    console.log('[OK] elementFromPoint 洞内:', r.inHoleId, '| 选区外:', r.outsideId)

    const ok =
      r.clipOk &&
      r.full.clip === 'none' && r.full.legacyHidden &&
      r.sel.display === 'block' && /polygon\(evenodd/.test(r.sel.clip) && r.sel.clip.includes('100px 100px') &&
      r.inHoleId !== 'mask' && r.outsideId === 'mask'

    console.log(ok ? '[PASS] clip-path 单遮罩挖洞正确' : '[FAIL] 挖洞异常')
    if (!ok) process.exitCode = 1
    win.destroy()
  } catch (e) {
    console.error('[FAIL]', e && e.message ? e.message : e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
app.on('window-all-closed', () => app.quit())
