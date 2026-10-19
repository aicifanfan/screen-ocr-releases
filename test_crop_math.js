// 纯逻辑单测：裁剪坐标计算（无需 GUI，普通 Node 即可运行）
// 运行：node test_crop_math.js
const { computeCrop } = require('./src/renderer/crop-math.js')

// 模拟 force=1 下两块屏：主屏 (0,0,2560,1600)，副屏 (-2560,0,2560,1600)
const displays = [
  { physX: 0, physY: 0, pxWidth: 2560, pxHeight: 1600, label: '主屏' },
  { physX: -2560, physY: 0, pxWidth: 2560, pxHeight: 1600, label: '副屏 1' }
]

let fails = 0
function eq(name, actual, expect) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect)
  if (a === e) console.log('[PASS]', name)
  else { console.log('[FAIL]', name, '=> got', a, 'expect', e); fails++ }
}

// 1. 主屏单屏裁剪
{
  const p = computeCrop(displays, { x: 100, y: 200, width: 300, height: 150 })
  eq('主屏单屏 out', [p.outWidth, p.outHeight], [300, 150])
  eq('主屏单屏 label', p.label, '主屏')
  eq('主屏单屏 blocks', p.blocks.map((b) => [b.sx, b.sy, b.sw, b.sh, b.dx, b.dy]), [[100, 200, 300, 150, 0, 0]])
}

// 2. 副屏单屏裁剪（x 为负，源坐标在副屏画布内偏移）
{
  const p = computeCrop(displays, { x: -2400, y: 100, width: 200, height: 100 })
  eq('副屏单屏 out', [p.outWidth, p.outHeight], [200, 100])
  eq('副屏单屏 label', p.label, '副屏 1')
  eq('副屏单屏 blocks', p.blocks.map((b) => [b.sx, b.sy, b.sw, b.sh, b.dx, b.dy]), [[160, 100, 200, 100, 0, 0]])
}

// 3. 跨屏拼接（横跨 -2560 与 0 交界）
{
  const p = computeCrop(displays, { x: -300, y: 100, width: 600, height: 200 })
  eq('跨屏 out', [p.outWidth, p.outHeight], [600, 200])
  eq('跨屏 label', p.label, '跨屏选区')
  eq('跨屏 block 数', p.blocks.length, 2)
  // 主屏块：x=0..300 → 源 sx=0..300，目标 dx=300
  eq('跨屏 主屏块', [p.blocks[0].sx, p.blocks[0].sw, p.blocks[0].dx], [0, 300, 300])
  // 副屏块：x=-300..0 → 源 sx=2260..2560，目标 dx=0
  eq('跨屏 副屏块', [p.blocks[1].sx, p.blocks[1].sw, p.blocks[1].dx], [2260, 300, 0])
}

// 4. 无交集
{
  const p = computeCrop(displays, { x: 5000, y: 5000, width: 100, height: 100 })
  eq('无交集返回 null', p, null)
}

// 5. 副屏在上方（负 y）场景
{
  const ds = [
    { physX: 0, physY: 0, pxWidth: 1920, pxHeight: 1080, label: '主屏' },
    { physX: 0, physY: -1080, pxWidth: 1920, pxHeight: 1080, label: '副屏 1' }
  ]
  const p = computeCrop(ds, { x: 100, y: -1080, width: 200, height: 100 })
  eq('上方副屏 label', p.label, '副屏 1')
  eq('上方副屏 out', [p.outWidth, p.outHeight], [200, 100])
}

// 6. 主副屏竖直排列（副屏在主屏上方，不同 y），确保只命中正确屏
{
  const ds = [
    { physX: 0, physY: 0, pxWidth: 2560, pxHeight: 1440, label: '主屏' },
    { physX: 0, physY: -1440, pxWidth: 2560, pxHeight: 1440, label: '副屏 1' }
  ]
  const p = computeCrop(ds, { x: 500, y: 500, width: 100, height: 100 })
  eq('竖直排列 主屏命中', p.label, '主屏')
}

console.log(fails === 0 ? '\n[ALL PASS]' : '\n[' + fails + ' FAILED]')
process.exit(fails === 0 ? 0 : 1)
