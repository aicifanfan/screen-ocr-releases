// 截屏链路耗时测量：按快捷键之后，主要开销在 desktopCapturer.getSources。
// 用法：
//   electron tests/perf/capture-latency.js                 # 与产品默认一致：软件渲染（disableGpu）
//   electron tests/perf/capture-latency.js --gpu           # 开启硬件加速
//   electron tests/perf/capture-latency.js --runs 5
const { app, desktopCapturer, screen, BrowserWindow } = require('electron')
const path = require('path')

const argv = process.argv.slice(2)
const USE_GPU = argv.includes('--gpu')
const RUNS = Number((argv[argv.indexOf('--runs') + 1] || '3').replace(/[^0-9]/g, '')) || 3

if (!USE_GPU) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const displays = screen.getAllDisplays()
  const maxPxW = Math.max(...displays.map((d) => d.bounds.width * (d.scaleFactor || 1)))
  const maxPxH = Math.max(...displays.map((d) => d.bounds.height * (d.scaleFactor || 1)))
  console.log('gpu=' + USE_GPU + '  displays=' + displays.length + '  thumbnail=' + maxPxW + 'x' + maxPxH)

  const times = []
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(maxPxW), height: Math.round(maxPxH) }
    })
    const ms = Date.now() - t0
    times.push(ms)
    const tEnc = Date.now();
    const jpegs = sources.map((s) => s.thumbnail.toJPEG(92).length)
    const encMs = Date.now() - tEnc
    const bytes = jpegs
    console.log('  run ' + (i + 1) + ': capture=' + ms + 'ms  toJPEG=' + encMs + 'ms  sources=' + sources.length + '  bytes=' + bytes.join(','))
    await sleep(150)
  }

  // 遮罩窗口创建 + 页面加载（不含截图）
  const t1 = Date.now()
  const win = new BrowserWindow({ width: 800, height: 600, show: false })
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html'))
  const loadMs = Date.now() - t1
  win.destroy()

  // 串行 vs 并行：截图 + 遮罩窗口加载，哪个顺序更快
  async function captureOnce() {
    return desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(maxPxW), height: Math.round(maxPxH) }
    })
  }
  async function makeOverlay() {
    const w = new BrowserWindow({ width: 800, height: 600, show: false })
    await w.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html'))
    return w
  }
  const serial = []
  const parallel = []
  for (let i = 0; i < RUNS; i++) {
    let t = Date.now()
    await captureOnce()
    const w1 = await makeOverlay()
    serial.push(Date.now() - t)
    w1.destroy()

    t = Date.now()
    await Promise.all([captureOnce(), makeOverlay()]).then(([, w2]) => w2.destroy())
    parallel.push(Date.now() - t)
  }
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)] }
  console.log('serial   = [' + serial.join(', ') + ']  median=' + med(serial) + 'ms')
  console.log('parallel = [' + parallel.join(', ') + ']  median=' + med(parallel) + 'ms')

  times.sort((a, b) => a - b)
  console.log('capture min=' + times[0] + 'ms  median=' + times[Math.floor(times.length / 2)] + 'ms  max=' + times[times.length - 1] + 'ms')
  console.log('overlay-load=' + loadMs + 'ms')
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
