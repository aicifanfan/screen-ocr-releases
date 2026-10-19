// 遮罩选区页（每块屏一个窗口实例）：多屏合成 + 跨屏拖拽框选 + 放大镜 + 裁剪
//
// 坐标系：全局物理坐标（force-device-scale-factor=1 下 CSS 像素 == 物理像素）。
// - 每个窗口只覆盖自己那块屏，窗口左上角在全局物理坐标 (originX, originY)。
// - 拖拽由主进程统一协调：主进程轮询全局鼠标坐标并广播 overlay:sync，
//   各窗口据此渲染自己视口内被框选的局部，实现跨屏无缝框选。
let displays = []   // 每屏 { dataUrl, physX, physY, pxWidth, pxHeight, label, canvas }
let originX = 0     // 本窗口左上角的全局物理 X
let originY = 0     // 本窗口左上角的全局物理 Y
let myIndex = -1
let screensReady = false   // 截图数据是否已就绪（「先出遮罩后填图」下，mouseup 需等待）
let readyResolve = null

const stage = document.getElementById('stage')
const screensEl = document.getElementById('screens')
const sel = document.getElementById('sel')
const tip = document.getElementById('size-tip')
const maskHole = document.getElementById('mask')
const mTop = document.getElementById('mask-top')
const mBottom = document.getElementById('mask-bottom')
const mLeft = document.getElementById('mask-left')
const mRight = document.getElementById('mask-right')
const mag = document.getElementById('mag')
const magCtx = mag.getContext('2d')

// clip-path polygon(evenodd) 特性检测：支持则用「单遮罩挖洞」，否则回退到 4 个 div 方案
const CLIP_OK = (() => {
  try { return CSS.supports('clip-path', 'polygon(evenodd, 0 0, 1px 0, 1px 1px)') } catch { return false }
})()

// 生成「外框 + 内框」的 evenodd 多边形（内框挖洞）
function holeClip(r, W, H) {
  return 'polygon(evenodd, 0 0, ' + W + 'px 0, ' + W + 'px ' + H + 'px, 0 ' + H + 'px, 0 0, ' +
    r.x + 'px ' + r.y + 'px, ' +
    r.x + 'px ' + (r.y + r.height) + 'px, ' +
    (r.x + r.width) + 'px ' + (r.y + r.height) + 'px, ' +
    (r.x + r.width) + 'px ' + r.y + 'px, ' +
    r.x + 'px ' + r.y + 'px)'
}

function hideLegacyMasks() {
  mTop.style.display = 'none'
  mBottom.style.display = 'none'
  mLeft.style.display = 'none'
  mRight.style.display = 'none'
}

const MAG_W = 150, MAG_H = 100, ZOOM = 3

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

// 本窗口覆盖的那块屏的物理宽高（窗口尺寸）
function myW() { const d = displays[myIndex]; return d ? d.pxWidth : window.innerWidth }
function myH() { const d = displays[myIndex]; return d ? d.pxHeight : window.innerHeight }

window.api.onScreens(async (payload) => {
  screensReady = false
  displays = (payload.displays || []).map((d) => ({ ...d }))
  myIndex = payload.myIndex
  const mine = displays[myIndex] || displays[0]
  originX = mine.physX
  originY = mine.physY
  await buildScreens()
  fullMask()
  screensReady = true
  if (readyResolve) { readyResolve(); readyResolve = null }
})

// 遮罩预热：复用窗口已显示时，立即切到「全屏遮罩」态（不等待新截图）
window.api.onPrepare(() => {
  fullMask()
})

// 等待截图数据就绪（最多 timeout），避免用旧图/空 canvas 裁剪
function waitScreensReady(timeout = 2500) {
  if (screensReady) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(() => { readyResolve = null; resolve() }, timeout)
    readyResolve = () => { clearTimeout(t); resolve() }
  })
}

// —— 选区渲染调度：合并到 requestAnimationFrame，每帧最多渲染一次 ——
// 主进程 16ms 轮询广播 + mousemove 都可能高频触发，直接同步渲染会造成重复布局/重绘。
let pendingRect = null
let selectionRaf = 0

function scheduleSelection(rect) {
  pendingRect = rect
  if (selectionRaf) return
  selectionRaf = requestAnimationFrame(() => {
    selectionRaf = 0
    if (pendingRect) renderSelection(pendingRect)
    else fullMask()
  })
}

// 主进程广播的拖拽状态（跨屏同步渲染）
window.api.onSync((payload) => {
  if (!payload.drag) { scheduleSelection(null); return }
  const r = normRect(
    { x: payload.drag.startX, y: payload.drag.startY },
    { x: payload.drag.curX, y: payload.drag.curY }
  )
  scheduleSelection(r)
})

// 每屏一张物理 canvas。只有本窗口覆盖的屏位于 (0,0)，其余屏的 canvas 在视口外（仅用于跨屏裁剪）。
async function buildScreens() {
  screensEl.innerHTML = ''
  for (const d of displays) {
    const canvas = document.createElement('canvas')
    canvas.width = d.pxWidth
    canvas.height = d.pxHeight
    canvas.style.left = (d.physX - originX) + 'px'
    canvas.style.top = (d.physY - originY) + 'px'
    canvas.style.width = d.pxWidth + 'px'
    canvas.style.height = d.pxHeight + 'px'
    const img = await loadImage(d.dataUrl)
    if (img) canvas.getContext('2d').drawImage(img, 0, 0, d.pxWidth, d.pxHeight)
    d.canvas = canvas
    screensEl.appendChild(canvas)
  }
}

function setMask(el, left, top, width, height) {
  el.style.left = left + 'px'
  el.style.top = top + 'px'
  el.style.width = width + 'px'
  el.style.height = height + 'px'
  el.style.display = 'block'
}

// 整窗半透明遮罩（无选区）
function fullMask() {
  if (CLIP_OK) {
    maskHole.style.display = 'block'
    maskHole.style.clipPath = 'none'
    hideLegacyMasks()
  } else {
    const W = myW(), H = myH()
    setMask(mTop, 0, 0, W, H)
    mBottom.style.display = 'none'
    mLeft.style.display = 'none'
    mRight.style.display = 'none'
    maskHole.style.display = 'none'
  }
  sel.style.display = 'none'
  tip.style.display = 'none'
}

function normRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

// 渲染选区：把全局物理矩形裁到本窗口视口内，用四块遮罩围出亮区 + 边框 + 尺寸提示
function renderSelection(globalRect) {
  const W = myW(), H = myH()
  const lx = globalRect.x - originX
  const ly = globalRect.y - originY
  const lw = globalRect.width
  const lh = globalRect.height

  // 与窗口视口求交
  const ix = Math.max(lx, 0)
  const iy = Math.max(ly, 0)
  const ix2 = Math.min(lx + lw, W)
  const iy2 = Math.min(ly + lh, H)
  if (ix >= ix2 || iy >= iy2) { fullMask(); return } // 选区完全不在本窗口

  const r = { x: ix, y: iy, width: ix2 - ix, height: iy2 - iy }
  sel.style.display = 'block'
  sel.style.left = r.x + 'px'
  sel.style.top = r.y + 'px'
  sel.style.width = r.width + 'px'
  sel.style.height = r.height + 'px'

  if (CLIP_OK) {
    // 单遮罩 + evenodd 挖洞：仅改 clip-path（paint），不触发 4 个 div 的逐帧 layout
    maskHole.style.display = 'block'
    maskHole.style.clipPath = holeClip(r, W, H)
    hideLegacyMasks()
  } else {
    // 回退：四块遮罩围出亮区
    maskHole.style.display = 'none'
    setMask(mTop, 0, 0, W, r.y)
    setMask(mBottom, 0, r.y + r.height, W, H - r.y - r.height)
    setMask(mLeft, 0, r.y, r.x, r.height)
    setMask(mRight, r.x + r.width, r.y, W - r.x - r.width, r.height)
  }

  tip.style.display = 'block'
  tip.textContent = Math.round(globalRect.width) + ' × ' + Math.round(globalRect.height)
  tip.style.left = r.x + 'px'
  tip.style.top = Math.max(0, r.y - 24) + 'px'
}

// 依据裁剪方案，从各屏物理 canvas 拷贝拼出选区画布
function cropRect(globalRect) {
  const plan = CropMath.computeCrop(displays, globalRect)
  if (!plan) return null
  const out = document.createElement('canvas')
  out.width = plan.outWidth
  out.height = plan.outHeight
  const ctx = out.getContext('2d')
  for (const b of plan.blocks) {
    ctx.drawImage(b.display.canvas, b.sx, b.sy, b.sw, b.sh, b.dx, b.dy, b.dw, b.dh)
  }
  return { canvas: out, label: plan.label }
}

// 放大镜：本窗口内鼠标位置对应的物理像素放大显示
function updateMagnifier(cx, cy) {
  const d = displays[myIndex]
  if (!d) { mag.style.display = 'none'; return }
  const px = cx + originX - d.physX
  const py = cy + originY - d.physY
  const srcW = MAG_W / ZOOM
  const srcH = MAG_H / ZOOM
  const sx = px - srcW / 2
  const sy = py - srcH / 2

  magCtx.clearRect(0, 0, MAG_W, MAG_H)
  magCtx.drawImage(d.canvas, sx, sy, srcW, srcH, 0, 0, MAG_W, MAG_H)
  magCtx.strokeStyle = 'rgba(255,60,60,0.9)'
  magCtx.lineWidth = 1
  magCtx.beginPath()
  magCtx.moveTo(MAG_W / 2, 0); magCtx.lineTo(MAG_W / 2, MAG_H)
  magCtx.moveTo(0, MAG_H / 2); magCtx.lineTo(MAG_W, MAG_H / 2)
  magCtx.stroke()

  const W = myW(), H = myH()
  let mx = cx + 16, my = cy + 16
  if (mx + MAG_W > W) mx = cx - 16 - MAG_W
  if (my + MAG_H > H) my = cy - 16 - MAG_H
  mag.style.left = Math.max(0, mx) + 'px'
  mag.style.top = Math.max(0, my) + 'px'
  mag.style.display = 'block'
}

document.addEventListener('mousedown', () => {
  window.api.dragStart().catch(() => {})
})

// 放大镜调度：合并到 rAF（mousemove 频率可达 125–1000Hz，远高于 60fps）
let pendingMouse = null
let magRaf = 0
document.addEventListener('mousemove', (e) => {
  pendingMouse = { x: e.clientX, y: e.clientY }
  if (magRaf) return
  magRaf = requestAnimationFrame(() => {
    magRaf = 0
    if (pendingMouse) updateMagnifier(pendingMouse.x, pendingMouse.y)
  })
})

document.addEventListener('mouseup', async () => {
  const rect = await window.api.dragEnd()
  if (!rect || rect.width < 4 || rect.height < 4) return

  await waitScreensReady() // 先出遮罩后填图：若截图尚未就绪则等待，避免裁到旧图

  try {
    const { canvas, label } = cropRect(rect) || {}
    if (!canvas) return
    const dataUrl = canvas.toDataURL('image/png')
    const result = await window.api.captureRegion(dataUrl)
    await window.api.showResult({ screens: [{ label: label || '选区', image: dataUrl, ...result }] })
    await window.api.closeOverlay()
  } catch (err) {
    alert('识别失败：' + (err && err.message ? err.message : err))
    await window.api.closeOverlay()
  }
})

document.addEventListener('mouseleave', () => { mag.style.display = 'none' })

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.closeOverlay()
})
