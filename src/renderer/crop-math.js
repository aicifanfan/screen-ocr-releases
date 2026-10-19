// 裁剪坐标计算（纯函数，无 DOM / canvas 依赖，可在浏览器与 Node 中共用以便单测）
//
// 坐标模型：全局物理坐标。
// force-device-scale-factor=1 让 CSS 像素 == 物理像素，所有屏的 scaleFactor 归 1，
// 因此框选裁剪退化为「矩形求交 + 1:1 拼接」，无需任何缩放换算。
//
// 每块屏 d = { physX, physY, pxWidth, pxHeight, label }
// globalRect = { x, y, width, height }（全局物理坐标）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.CropMath = factory()
})(typeof self !== 'undefined' ? self : this, function () {

  function intersects(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by
  }

  // 计算裁剪方案。
  // 返回 { outWidth, outHeight, blocks, label } 或 null（无交集）。
  // blocks[i] = { display, sx, sy, sw, sh, dx, dy, dw, dh }
  //   sx/sy/sw/sh —— 在 display.canvas 上的物理源矩形；
  //   dx/dy/dw/dh —— 在输出画布上的目标矩形（1:1）。
  function computeCrop(displays, rect) {
    const gx = rect.x, gy = rect.y, gw = rect.width, gh = rect.height
    const hits = displays.filter((d) =>
      intersects(gx, gy, gw, gh, d.physX, d.physY, d.pxWidth, d.pxHeight)
    )
    if (!hits.length) return null

    const blocks = []
    for (const d of hits) {
      const ix = Math.max(gx, d.physX)
      const iy = Math.max(gy, d.physY)
      const iw = Math.min(gx + gw, d.physX + d.pxWidth) - ix
      const ih = Math.min(gy + gh, d.physY + d.pxHeight) - iy
      blocks.push({
        display: d,
        sx: Math.round(ix - d.physX),
        sy: Math.round(iy - d.physY),
        sw: Math.max(1, Math.round(iw)),
        sh: Math.max(1, Math.round(ih)),
        dx: Math.round(ix - gx),
        dy: Math.round(iy - gy),
        dw: Math.max(1, Math.round(iw)),
        dh: Math.max(1, Math.round(ih))
      })
    }

    return {
      outWidth: Math.max(1, Math.round(gw)),
      outHeight: Math.max(1, Math.round(gh)),
      blocks,
      label: hits.length === 1 ? hits[0].label : '跨屏选区'
    }
  }

  return { computeCrop, intersects }
})
