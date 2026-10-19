// 遮罩页自检：多屏合成（每屏物理 canvas + 全局物理坐标）+ 单屏/跨屏裁剪
// 运行（真机）：npx electron test_overlay.js
const { app, BrowserWindow } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')

const PRELOAD = path.join(__dirname, 'src', 'preload', 'index.js')
const OVERLAY = path.join(__dirname, 'src', 'renderer', 'overlay.html')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  await win.loadFile(OVERLAY)

  // 生成两张纯色 PNG 作为两个「显示器」
  const colors = await win.webContents.executeJavaScript(`(function(){
    function solid(w,h,c){ const cv=document.createElement('canvas'); cv.width=w; cv.height=h; const x=cv.getContext('2d'); x.fillStyle=c; x.fillRect(0,0,w,h); return cv.toDataURL('image/png'); }
    return { red: solid(80,80,'#ff0000'), blue: solid(30,30,'#0000ff') };
  })()`)

  // 模拟 force=1 两屏（均为 1:1 物理像素）：红屏(主) 80x80 @ (0,0)，蓝屏(副) 30x30 @ (80,0)
  const payload = {
    displays: [
      { dataUrl: colors.red,  physX: 0,  physY: 0, pxWidth: 80, pxHeight: 80, label: '主屏', isPrimary: true },
      { dataUrl: colors.blue, physX: 80, physY: 0, pxWidth: 30, pxHeight: 30, label: '副屏 1', isPrimary: false }
    ],
    physVirtual: { x: 0, y: 0, width: 110, height: 80 },
    myIndex: 0
  }
  win.webContents.send('overlay:screens', payload)

  const r = await waitReady(win)
  console.log('[OK] 屏 canvas 数量:', r.canCount, '(期望 2)')
  console.log('[OK] 红屏尺寸:', r.redSize, '(期望 [80,80]), CSS位置:', r.redCss)
  console.log('[OK] 蓝屏尺寸:', r.blueSize, '(期望 [30,30]), CSS位置:', r.blueCss)
  console.log('[OK] 红屏采样(10,10):', r.redPx, '(期望红)')
  console.log('[OK] 蓝屏采样(10,10):', r.bluePx, '(期望蓝)')
  console.log('[OK] 单屏裁剪-红:', r.crSize, r.crPx, '(期望 20x10 红)')
  console.log('[OK] 单屏裁剪-蓝:', r.cbSize, r.cbPx, '(期望 10x10 蓝)')
  console.log('[OK] 跨屏拼接:', r.cmSize, r.cmLeft, r.cmRight, '(期望 20x10 左红右蓝)')

  const ok =
    r.canCount === 2 &&
    r.redSize[0] === 80 && r.redSize[1] === 80 &&
    r.blueSize[0] === 30 && r.blueSize[1] === 30 &&
    r.redPx[0] === 255 && r.redPx[1] === 0 && r.redPx[2] === 0 &&
    r.bluePx[0] === 0 && r.bluePx[1] === 0 && r.bluePx[2] === 255 &&
    r.crSize[0] === 20 && r.crSize[1] === 10 && r.crPx[0] === 255 &&
    r.cbSize[0] === 10 && r.cbSize[1] === 10 && r.cbPx[2] === 255 &&
    r.cmSize[0] === 20 && r.cmSize[1] === 10 &&
    r.cmLeft[0] === 255 && r.cmRight[2] === 255

  console.log(ok ? '[PASS] 多屏渲染 + 单屏/跨屏裁剪正确' : '[FAIL] 结果不符')
  if (!ok) process.exitCode = 1
  app.quit()
})

async function waitReady(win) {
  for (let i = 0; i < 100; i++) {
    const r = await win.webContents.executeJavaScript(`(function(){
      function sample(cv, x, y){ return Array.from(cv.getContext('2d').getImageData(x,y,1,1).data); }
      const cans = document.querySelectorAll('#screens canvas');
      if (cans.length < 2) return null;
      const redC = cans[0], blueC = cans[1];
      const redPx = sample(redC, 10, 10), bluePx = sample(blueC, 10, 10);
      if (!(redPx[0]===255 && redPx[1]===0) || !(bluePx[2]===255)) return null;
      const cr = cropRect({x:10,y:10,width:20,height:10});      // 红屏内
      const cb = cropRect({x:85,y:12,width:10,height:10});      // 蓝屏内
      const cm = cropRect({x:70,y:5,width:20,height:10});       // 跨屏
      return {
        canCount: cans.length,
        redSize: [redC.width, redC.height],
        blueSize: [blueC.width, blueC.height],
        redCss: [redC.style.left, redC.style.top, redC.style.width, redC.style.height],
        blueCss: [blueC.style.left, blueC.style.top, blueC.style.width, blueC.style.height],
        redPx, bluePx,
        crSize: [cr.canvas.width, cr.canvas.height],
        crPx: sample(cr.canvas, 5, 5),
        cbSize: [cb.canvas.width, cb.canvas.height],
        cbPx: sample(cb.canvas, 5, 5),
        cmSize: [cm.canvas.width, cm.canvas.height],
        cmLeft: sample(cm.canvas, 5, 5),
        cmRight: sample(cm.canvas, 15, 5)
      };
    })()`)
    if (r) return r
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('渲染超时')
}

app.on('window-all-closed', () => app.quit())
