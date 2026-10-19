// 屏幕捕获：多显示器 + 统一物理坐标（force-device-scale-factor=1）
const { desktopCapturer, screen } = require('electron')

// JPEG 替代 PNG：PNG 编码 CPU 密集且同步阻塞，JPEG 编码快 3~10 倍、体积小 5~10 倍。
// 屏幕截图不透明（无 alpha），JPEG quality 92 对文字识别几乎无损。
const JPEG_QUALITY = 92

function toJpegDataUrl(image) {
  try {
    const buf = image.toJPEG(JPEG_QUALITY)
    if (buf && buf.length) return 'data:image/jpeg;base64,' + buf.toString('base64')
  } catch (e) {
    console.warn('[capture] toJPEG 失败，回退 PNG：', e && e.message)
  }
  return image.toDataURL() // 兜底：极端情况下仍保证可用
}

/**
 * 捕获所有显示器，返回各自截图与虚拟桌面边界。
 *
 * 设计要点：
 * - 主进程已强制 force-device-scale-factor=1，因此所有屏 scaleFactor 恒为 1，
 *   display.bounds / 鼠标坐标 / 窗口 bounds / desktopCapturer 缩略图全部统一为物理像素，
 *   各屏 1:1，无需混合 DPI 换算。
 * - physX/physY/pxWidth/pxHeight 即物理位置与物理尺寸（scaleFactor=1 时与 bounds 相等，
 *   仍显式乘 scaleFactor 以保持健壮）。
 *
 * @returns {{
 *   displays: Array<{dataUrl:string, x:number, y:number, width:number, height:number,
 *                    scaleFactor:number, physX:number, physY:number,
 *                    pxWidth:number, pxHeight:number,
 *                    id:string, isPrimary:boolean, label:string}>,
 *   virtual: {x:number, y:number, width:number, height:number},       // DIP 包围盒
 *   physVirtual: {x:number, y:number, width:number, height:number},   // 物理包围盒
 *   primaryScaleFactor: number
 * }}
 */
async function captureAllScreens() {
  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const primaryScaleFactor = primary.scaleFactor || 1

  // DIP 包围盒（虚拟桌面），坐标可能为负（副屏在主屏左侧/上方）
  const minX = Math.min(...displays.map((d) => d.bounds.x))
  const minY = Math.min(...displays.map((d) => d.bounds.y))
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  const virtual = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }

  // thumbnailSize 上限 = 各屏物理尺寸的最大值（保证每屏 thumbnail 不缩水、拿到 1:1 物理像素）
  const maxPxW = Math.max(...displays.map((d) => d.bounds.width * (d.scaleFactor || 1)))
  const maxPxH = Math.max(...displays.map((d) => d.bounds.height * (d.scaleFactor || 1)))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(maxPxW)),
      height: Math.max(1, Math.round(maxPxH))
    }
  })

  const out = []
  for (let i = 0; i < displays.length; i++) {
    const d = displays[i]
    const bounds = d.bounds
    const sf = d.scaleFactor || 1

    // ① 精确匹配：display_id
    let source = sources.find((s) => String(s.display_id) === String(d.id))
    // ② 兜底：按宽高比匹配（thumbnail 宽高比 == 该屏 bounds 宽高比）
    if (!source) {
      const ratio = bounds.width / bounds.height
      source = sources.find((s) => {
        const sz = s.thumbnail.getSize()
        return (
          sz.width > 0 &&
          sz.height > 0 &&
          Math.abs(sz.width / sz.height - ratio) < 0.05
        )
      })
    }
    // ③ 最终兜底：按索引
    if (!source) source = sources[i] || sources[0]
    if (!source) continue

    out.push({
      dataUrl: toJpegDataUrl(source.thumbnail),
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,   // DIP
      height: bounds.height, // DIP
      scaleFactor: sf,
      physX: Math.round(bounds.x * sf),          // 物理 X
      physY: Math.round(bounds.y * sf),          // 物理 Y
      pxWidth: Math.round(bounds.width * sf),    // 物理像素
      pxHeight: Math.round(bounds.height * sf),  // 物理像素
      id: String(d.id),
      isPrimary: d.id === primary.id,
      label: d.id === primary.id ? '主屏' : `副屏 ${out.filter((o) => !o.isPrimary).length + 1}`
    })
  }

  if (!out.length) throw new Error('未捕获到任何显示器')

  // 物理包围盒
  const pMinX = Math.min(...out.map((d) => d.physX))
  const pMinY = Math.min(...out.map((d) => d.physY))
  const pMaxX = Math.max(...out.map((d) => d.physX + d.pxWidth))
  const pMaxY = Math.max(...out.map((d) => d.physY + d.pxHeight))
  const physVirtual = { x: pMinX, y: pMinY, width: pMaxX - pMinX, height: pMaxY - pMinY }

  return { displays: out, virtual, physVirtual, primaryScaleFactor }
}

module.exports = { captureAllScreens }
