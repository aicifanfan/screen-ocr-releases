// 精修结果合并（纯函数，便于单测）
//
// sidecar 的两段式/流式精修都是「同 seq 多次推送」：
//   - 一次性：一条 refined 就把所有行换完
//   - 流式：每算完一批推一条，texts 是当前累计的完整数组，done/total 表示进度，final 表示结束
// 这里只做「合并进最近一次结果」，不碰窗口/IPC，方便测试与复用。

/**
 * 把一条 refined 包合并进 payload（就地修改）。
 * @param {{screens?: Array}} payload 最近一次识别结果
 * @param {{seq:number, texts?: string[], scores?: number[], lines?: number,
 *          refined?: boolean, done?: number, total?: number, final?: boolean}} msg
 * @returns {boolean} 是否合并成功（找不到对应屏幕时 false，调用方会先缓存）
 */
function applyRefined(payload, msg) {
  if (!payload || !Array.isArray(payload.screens) || !msg) return false
  const screens = payload.screens
  let idx = screens.findIndex((s) => s && s.seq != null && s.seq === msg.seq)
  if (idx < 0) {
    // 兜底只针对「结果里根本没有 seq」（老数据/纯文本结果）的单屏场景。
    // 如果结果带 seq 但对不上，说明这条精修属于上一次截图 —— 必须丢掉，
    // 否则会把新截图的内容替换成上一张的文本，甚至把「精修中」状态挂到新结果上。
    const hasSeq = screens.some((s) => s && s.seq != null)
    if (!hasSeq && screens.length === 1) idx = 0
  }
  if (idx < 0) return false

  const s = screens[idx]
  if (Array.isArray(msg.texts) && msg.texts.length) {
    // 行数理论上不变（检测没重跑）；真变了也整体替换——宁可牺牲选中位置，也不显示旧文本
    s.texts = msg.texts
    if (Array.isArray(msg.scores)) s.scores = msg.scores
  }

  payload.refined = true
  payload.provisional = false
  payload.refinedLines = msg.refined === false ? 0 : (msg.lines || 0)
  // 老 sidecar 没有 final/total 字段 → 视为「一次推完」，行为与 0.3.2 一致
  payload.refiningDone = msg.final !== false
  if (msg.total != null) payload.refineProgress = { done: msg.done || 0, total: msg.total }
  return true
}

module.exports = { applyRefined }
