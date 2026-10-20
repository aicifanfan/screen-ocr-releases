// 精修合并（src/main/refined.js）单测：覆盖一次性推送与流式分批推送的合并契约。
// 这里是「主进程 ↔ 渲染层」之间的数据契约，坏了表现是文字不刷新或提示不停，纯 Node 就能测。
const assert = require('assert')
const { applyRefined } = require('../src/main/refined')

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail !== undefined ? '  ' + detail : ''))
}
function payloadWith(texts, seq = 7) {
  return { provisional: true, screens: [{ seq, texts: texts.slice(), scores: texts.map(() => 0.8) }] }
}

// 1) 流式第一批：只替换已完成的行，但不标记完成
{
  const p = payloadWith(['a', 'b', 'c'])
  const ok = applyRefined(p, { seq: 7, texts: ['A', 'b', 'c'], scores: [0.99, 0.8, 0.8], done: 1, total: 3, final: false, lines: 3, refined: true })
  check('部分批次：合并成功', ok === true)
  check('部分批次：文本已替换', JSON.stringify(p.screens[0].texts) === JSON.stringify(['A', 'b', 'c']), p.screens[0].texts.join(','))
  check('部分批次：refiningDone=false（提示要继续挂着）', p.refiningDone === false, String(p.refiningDone))
  check('部分批次：带进度 1/3', p.refineProgress && p.refineProgress.done === 1 && p.refineProgress.total === 3,
    JSON.stringify(p.refineProgress))
  check('部分批次：provisional 已撤销', p.provisional === false)
}

// 2) 最后一批：标记完成
{
  const p = payloadWith(['a', 'b', 'c'])
  applyRefined(p, { seq: 7, texts: ['A', 'B', 'C'], scores: [0.99, 0.99, 0.99], done: 3, total: 3, final: true, lines: 3 })
  check('最终批次：refiningDone=true（提示收起）', p.refiningDone === true)
  check('最终批次：全部替换', p.screens[0].texts.join('') === 'ABC')
  check('最终批次：refinedLines=行数', p.refinedLines === 3, String(p.refinedLines))
}

// 3) 老 sidecar（没有 final/total）：按「一次推完」处理
{
  const p = payloadWith(['a', 'b'])
  applyRefined(p, { seq: 7, texts: ['A', 'B'], scores: [1, 1], refined: true, lines: 2 })
  check('老协议：视为已完成', p.refiningDone === true)
  check('老协议：不产生进度字段', p.refineProgress === undefined)
}

// 4) 空结果（没有可精修的行）：也要收尾
{
  const p = payloadWith([])
  const ok = applyRefined(p, { seq: 7, texts: [], scores: [], refined: false, lines: 0, done: 0, total: 0, final: true })
  check('空结果：合并成功且完成', ok === true && p.refiningDone === true)
  check('空结果：refinedLines=0', p.refinedLines === 0, String(p.refinedLines))
}

// 5) 多屏：seq 不匹配 → 交给调用方缓存（返回 false，不改数据）
{
  const p = { screens: [{ seq: 1, texts: ['x'] }, { seq: 2, texts: ['y'] }] }
  const before = JSON.stringify(p)
  const ok = applyRefined(p, { seq: 9, texts: ['Z'], done: 1, total: 1, final: true })
  check('多屏不匹配：返回 false', ok === false)
  check('多屏不匹配：不修改数据', JSON.stringify(p) === before)
}

// 5b) 单屏但 seq 对不上（新一次截图已替换数据）→ 必须丢弃，不能覆盖新结果
{
  const p = { screens: [{ seq: 6, texts: ['新一', '新二'] }] }
  const ok = applyRefined(p, { seq: 5, texts: ['旧一', '旧二', '旧三'], done: 3, total: 3, final: true })
  check('单屏 seq 不匹配：返回 false（旧精修不污染新截图）', ok === false)
  check('单屏 seq 不匹配：新结果文本保持不变', JSON.stringify(p.screens[0].texts) === JSON.stringify(['新一', '新二']),
    JSON.stringify(p.screens[0].texts))
  check('单屏 seq 不匹配：不会把 refiningDone 挂上去', p.refiningDone === undefined)
}

// 6) 单屏兜底：结果里没有 seq 也能合并
{
  const p = { screens: [{ texts: ['x'] }] }
  const ok = applyRefined(p, { seq: 5, texts: ['X'], done: 1, total: 1, final: true })
  check('单屏兜底：无 seq 也能合并', ok === true && p.screens[0].texts[0] === 'X')
}

// 7) 行数变化：整体替换（宁可牺牲选中位置也不显示旧文本）
{
  const p = payloadWith(['a', 'b'])
  applyRefined(p, { seq: 7, texts: ['a', 'b', 'c'], scores: [1, 1, 1], done: 3, total: 3, final: true })
  check('行数变化：整体替换', p.screens[0].texts.length === 3, 'len=' + p.screens[0].texts.length)
}

// 8) 非法输入
{
  check('空 payload 返回 false', applyRefined(null, { seq: 1 }) === false)
  check('空 msg 返回 false', applyRefined({ screens: [{ seq: 1 }] }, null) === false)
  check('payload 无 screens 返回 false', applyRefined({}, { seq: 1, texts: ['x'] }) === false)
}

console.log(pass ? '[ALL PASS] 精修合并（一次性 + 流式分批）契约通过' : '[FAIL] 存在未通过项')
process.exit(pass ? 0 : 1)
