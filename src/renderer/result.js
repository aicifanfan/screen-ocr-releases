// 结果页逻辑：多屏分组展示 + 可编辑文字块 + 原图对照（双向联动）+ 复制交互
const mainEl = document.getElementById('main')
const statusEl = document.getElementById('status')
const refiningEl = document.getElementById('refining')
const toggleBoxes = document.getElementById('toggle-boxes')
const autoCloseEl = document.getElementById('auto-close')

let screens = [] // [{ label, image, items: [{ text, box, score }] }]
let hasResult = false // 是否有识别结果（用于语言切换后重绘空状态）

// 两段式渐进：临时结果已上屏、最终结果还没来
let refining = false
// 流式精修进度（{ done, total }）：拿到就显示「精修中 12/64」，没有就只显示「精修中…」
let refineProgress = null
let deferredPayload = null // 用户正在选字时先攒着，等选区收起再替换
let deferredTimer = 0

// 临时提示的计时器：非空时抑制「已选 N 字」的实时计数，避免两者打架
let flashTimer = null

// —— 语言 ——
let lang = I18n.normalizeLang(window.api.initialLanguage)
function t(key, params) { return I18n.t(lang, key, params) }

// 切换语言后就地重绘（静态文案 + 动态分组内容），无需刷新页面
function applyLanguage(next) {
  if (next) lang = I18n.normalizeLang(next)
  I18n.applyDom(document, lang)
  document.title = t('result.title')
  // 复制反馈的"原文"是上一次语言的文案，切语言后必须丢弃，否则会恢复成旧语言
  document.querySelectorAll('[data-idle-text]').forEach((el) => { delete el.dataset.idleText })
  if (hasResult) renderAll()
  else renderEmpty()
  updateSelectionStatus() // 计数文案也要跟着语言切换
}

window.api.onLanguageChanged((payload) => {
  if (payload && payload.lang) applyLanguage(payload.lang)
})

// 拖拽选字期间抑制悬停底色：否则鼠标扫过每一行都会亮一下，像高亮在追指针。
// 必须绑在 document 上：拖到面板外松手时也要能清掉状态。
let selecting = false
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  selecting = true
  document.body.classList.add('is-selecting')
})
function endSelecting() {
  if (!selecting) return
  selecting = false
  document.body.classList.remove('is-selecting')
}
document.addEventListener('pointerup', endSelecting)
document.addEventListener('pointercancel', endSelecting)

// 临时提示：显示 1.5s 后自动让位给选中计数
function flash(msg) {
  if (flashTimer) clearTimeout(flashTimer)
  statusEl.textContent = msg
  statusEl.classList.remove('is-count')
  flashTimer = setTimeout(() => {
    flashTimer = null
    updateSelectionStatus()
  }, 1500)
}

// 选中字数（去掉首尾空白，避免只选中换行也计入）
function getSelectionLength() {
  const s = window.getSelection()
  return s ? s.toString().trim().length : 0
}

// 实时反映「是否已选中文字」：状态条显示字数，复制选中按钮的可用态同步切换
function updateSelectionStatus() {
  if (flashTimer) return // 临时提示优先
  const n = getSelectionLength()
  const btn = document.getElementById('btn-copy-sel')
  if (btn) btn.disabled = n === 0
  if (n > 0) {
    statusEl.textContent = t('result.selectedChars', { n })
    statusEl.classList.add('is-count')
  } else {
    statusEl.textContent = ''
    statusEl.classList.remove('is-count')
  }
}

// 选区变化很频繁：合并到一帧内只处理一次。
// 兜底定时器：窗口被遮挡/最小化时 Chromium 会暂停 rAF，状态不能永远停在旧值。
let selRaf = 0
let selTimer = 0
function flushSelectionStatus() {
  if (selRaf) { cancelAnimationFrame(selRaf); selRaf = 0 }
  if (selTimer) { clearTimeout(selTimer); selTimer = 0 }
  updateSelectionStatus()
}
document.addEventListener('selectionchange', () => {
  if (selRaf || selTimer) return
  selRaf = requestAnimationFrame(() => {
    selRaf = 0
    if (selTimer) { clearTimeout(selTimer); selTimer = 0 }
    updateSelectionStatus()
  })
  selTimer = setTimeout(flushSelectionStatus, 120)
})

// 复制反馈：只换文案 + 加成功态，1.2s 后还原
const feedbackTimers = new WeakMap()
function buttonFeedback(btn, text) {
  // 首次点击时锁定宽度：文案变短（"复制全文"→"已复制"）不会带着整条工具栏抖动
  if (!btn.style.minWidth) btn.style.minWidth = btn.offsetWidth + 'px'
  // 记住「非反馈态」的文案：连续点击时不会把"已复制"当成原文恢复
  if (!btn.dataset.idleText) btn.dataset.idleText = btn.textContent
  clearTimeout(feedbackTimers.get(btn))
  btn.textContent = text
  btn.classList.add('is-done')
  feedbackTimers.set(btn, setTimeout(() => {
    btn.textContent = btn.dataset.idleText
    btn.classList.remove('is-done')
  }, 1200))
}

// 空状态图标：纯装饰（无文字），不参与文案与 i18n
const EMPTY_ICON = tag => (
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + tag + '</svg>'
)
const ICON_NO_TEXT = EMPTY_ICON(
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
  '<path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>'
)

// 空状态：图标 + 文案；整页空状态额外带一行提示
// 注意：.empty 的 textContent 必须恰好等于文案（i18n 测试按精确值断言）
function createEmptyState(withHint) {
  const empty = document.createElement('div')
  empty.className = 'empty'

  const icon = document.createElement('span')
  icon.className = 'empty-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = ICON_NO_TEXT

  const text = document.createElement('span')
  text.className = 'empty-text'
  text.textContent = t('result.empty')

  empty.append(icon, text)
  if (!withHint) return empty

  const wrap = document.createElement('div')
  wrap.className = 'empty-state'
  const hint = document.createElement('p')
  hint.className = 'empty-hint'
  hint.textContent = t('result.emptyHint')
  wrap.append(empty, hint)
  return wrap
}

// 加载骨架：两栏结构与真实内容一致，数据到达时布局不跳
function renderLoading() {
  mainEl.innerHTML = ''
  mainEl.classList.add('is-loading')
  mainEl.setAttribute('aria-busy', 'true')

  const sk = document.createElement('div')
  sk.className = 'skeleton'
  sk.setAttribute('aria-hidden', 'true')

  const left = document.createElement('div')
  left.className = 'skeleton-col'
  ;[92, 76, 88, 64, 84, 70].forEach((w) => {
    const line = document.createElement('div')
    line.className = 'skeleton-line'
    line.style.width = w + '%'
    left.appendChild(line)
  })

  const right = document.createElement('div')
  right.className = 'skeleton-col is-media'
  const block = document.createElement('div')
  block.className = 'skeleton-block'
  right.appendChild(block)

  sk.append(left, right)
  mainEl.appendChild(sk)
}

function endLoading() {
  mainEl.classList.remove('is-loading')
  mainEl.setAttribute('aria-busy', 'false')
}

// 空状态（未识别到文字）
function renderEmpty() {
  endLoading()
  refining = false // 没有内容时不该挂「精修中」
  refineProgress = null
  mainEl.innerHTML = ''
  mainEl.appendChild(createEmptyState(true))
  updateRefiningChip()
}

// 核心：根据结果渲染（首次打开与连续截图刷新共用）
// 兼容两种结构：{ screens:[{label,image,texts,boxes,scores}] } 或旧 { texts,boxes,scores,image }
function render(result) {
  // 边界：结构与字段都可能缺失（旧版本主进程、异常数据）→ 不抛错，退回空状态
  if (!result || typeof result !== 'object') {
    hasResult = false
    renderEmpty()
    return
  }

  const raw = Array.isArray(result.screens) && result.screens.length ? result.screens : [{
    label: result.label || '',
    image: result.image,
    texts: result.texts || [],
    boxes: result.boxes,
    scores: result.scores
  }]

  screens = raw.filter(Boolean).map((s) => {
    // texts/boxes/scores 长度可能不一致：以 texts 为准，越界按 null 处理
    const texts = Array.isArray(s.texts) ? s.texts : []
    const boxes = Array.isArray(s.boxes) ? s.boxes : []
    const scores = Array.isArray(s.scores) ? s.scores : []
    const items = texts.map((t, i) => ({
      text: t == null ? '' : String(t),
      box: Array.isArray(boxes[i]) && boxes[i].length >= 4 ? boxes[i] : null,
      score: typeof scores[i] === 'number' ? scores[i] : null
    }))
    // 按坐标还原大致阅读顺序：先按 y（行），同行的按 x（列）
    items.sort((a, b) => {
      const ay = a.box ? a.box[1] : 0
      const by = b.box ? b.box[1] : 0
      const ax = a.box ? a.box[0] : 0
      const bx = b.box ? b.box[0] : 0
      if (Math.abs(ay - by) > 10) return ay - by
      return ax - bx
    })
    return {
      label: s.label || '',
      labelKind: s.labelKind || '',
      labelIndex: s.labelIndex || 0,
      image: s.image,
      items
    }
  })

  hasResult = true
  // 两段式渐进：临时结果（provisional）先上屏，并挂「精修中…」提示；
  // 流式精修会分批推送（refiningDone=false），提示要一直挂到最后一个 final 包。
  refining = result.provisional === true || result.refiningDone === false
  refineProgress = result.refineProgress || null
  renderAll()
}

function renderAll() {
  endLoading()
  // 精修替换会重建 DOM：先记住两个面板的滚动位置，重建后还原，
  // 否则用户正在看的段落会被顶回顶部。
  const prevScroll = Array.from(mainEl.querySelectorAll('.text-panel, .img-panel'))
    .map((el) => el.scrollTop)
  if (imgResizeObserver) imgResizeObserver.disconnect() // 旧面板已移除，解除监听
  mainEl.innerHTML = ''
  // 重绘后旧节点已不存在，联动记录一并作废
  hoverLink = null
  pinnedLink = null
  // 仅多屏时显示标题（单屏无需区分来源）
  const showTitle = screens.length > 1
  screens.forEach((s, si) => renderScreen(s, si, showTitle))

  if (prevScroll.length) {
    const panels = mainEl.querySelectorAll('.text-panel, .img-panel')
    panels.forEach((el, i) => {
      if (i < prevScroll.length && prevScroll[i]) el.scrollTop = prevScroll[i]
    })
  }
  updateRefiningChip()
}

// 「精修中…」提示：只在两段式渐进的第一段上屏后显示，流式精修时带进度
function updateRefiningChip() {
  if (!refiningEl) return
  refiningEl.hidden = !refining
  if (!refining) return
  const p = refineProgress
  refiningEl.textContent = p && p.total
    ? t('result.refiningProgress', { done: p.done, total: p.total })
    : t('result.refining')
}

// 窗口从宽改窄时按新宽度重算图片缩放：否则图片保持旧尺寸，出现横向溢出、识别框错位。
// 只复用 drawBoxes 的既有布局逻辑，不改变任何数据与交互。
// 回调推迟到下一帧：drawBoxes 会改图片尺寸，同步执行可能再次触发自身的 resize 通知。
const imgResizeObserver = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver((entries) => {
    for (const entry of entries) {
      const panel = entry.target
      if (!panel._img || !panel._img.naturalWidth || panel._resizeRaf) continue
      panel._resizeRaf = requestAnimationFrame(() => {
        panel._resizeRaf = 0
        drawBoxes(panel._img, panel._screen, panel._si)
      })
    }
  })
  : null

// 按当前语言生成分组标题：优先用主进程给的 labelKind，避免把中文屏名写死进结果数据
function screenTitle(s, si) {
  switch (s.labelKind) {
    case 'primary': return t('result.primaryScreen')
    case 'secondary': return t('result.secondaryScreenN', { n: s.labelIndex || 1 })
    case 'cross': return t('result.crossScreen')
    case 'selection': return t('result.selectionLabel')
    default: return s.label || t('result.screenN', { n: si + 1 })
  }
}

// 渲染单屏分组：标题（多屏时）+ 左文字 + 右原图
function renderScreen(s, si, showTitle) {
  const group = document.createElement('div')
  group.className = 'screen-group'

  if (showTitle) {
    const title = document.createElement('div')
    title.className = 'screen-title'
    title.textContent = screenTitle(s, si)
    group.appendChild(title)
  }

  const body = document.createElement('div')
  body.className = 'screen-body'

  // 左：文字块
  // 单一编辑根：整个面板只有一个 contentEditable，每行是它的块级子节点。
  // 原因：Blink 会把拖选钳制在单个「编辑主机」内，逐行 contentEditable 会让跨行只选中首行。
  const textPanel = document.createElement('div')
  textPanel.className = 'text-panel'

  const editor = document.createElement('div')
  editor.className = 'editor'
  editor.contentEditable = 'true'
  editor.spellcheck = false
  editor.dataset.screen = si

  s.items.forEach((it, i) => {
    const div = document.createElement('div')
    div.className = 'item'
    div.textContent = it.text
    div.dataset.screen = si
    div.dataset.index = i
    if (it.score != null) div.title = t('result.confidence', { percent: Math.round(it.score * 100) })
    div.addEventListener('click', () => focusBox(si, i))
    editor.appendChild(div)
  })

  // 行数必须与识别框一一对应，否则「复制全文」会串行：按索引回写 items
  editor.addEventListener('input', () => {
    editor.querySelectorAll(':scope > .item').forEach((el, i) => {
      if (s.items[i]) s.items[i].text = el.textContent
    })
  })

  // 拦截回车：不允许拆出新块（1 行 = 1 个识别框）。行内不提供换行，
  // 需要换行时应由 OCR 结果本身给出独立的行。
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) e.preventDefault()
  })

  // 粘贴压平为单行，避免多行文本创建新块、破坏行与识别框的映射
  editor.addEventListener('paste', (e) => {
    e.preventDefault()
    const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
    document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' '))
  })

  if (s.items.length) {
    textPanel.appendChild(editor)
  } else {
    // 单屏内空状态：只保留紧凑图标 + 文案，不重复整页提示
    textPanel.appendChild(createEmptyState(false))
  }
  body.appendChild(textPanel)

  // 右：原图 + 识别框
  const imgPanel = document.createElement('div')
  imgPanel.className = 'img-panel'
  if (s.image) {
    const wrap = document.createElement('div')
    wrap.className = 'img-wrap'

    const img = document.createElement('img')
    img.draggable = false
    img.alt = t('result.imageAlt')
    img.decoding = 'async' // 解码不阻塞首屏排版
    img.onload = () => drawBoxes(img, s, si)
    // 边界：base64 损坏 / 加载失败 → 占位，不留一个破图图标
    img.onerror = () => {
      if (imgPanel._img === img) {
        imgPanel._img = null
        imgPanel._boxLayer = null
      }
      if (wrap.parentElement === imgPanel) imgPanel.replaceChild(createImagePlaceholder(), wrap)
    }
    img.src = s.image

    const boxLayer = document.createElement('div')
    boxLayer.className = 'box-layer'
    boxLayer.style.display = toggleBoxes.checked ? 'block' : 'none'

    wrap.appendChild(img)
    wrap.appendChild(boxLayer)
    imgPanel.appendChild(wrap)
    imgPanel._img = img
    imgPanel._boxLayer = boxLayer
    imgPanel._displayScale = 1
    imgPanel._screen = s
    imgPanel._si = si
    if (imgResizeObserver) imgResizeObserver.observe(imgPanel)
  } else {
    // 边界：识别成功但没有截图（如纯文本结果）——占位而不是留一片空白
    imgPanel.appendChild(createImagePlaceholder())
  }
  body.appendChild(imgPanel)

  group.appendChild(body)
  mainEl.appendChild(group)
}

function createImagePlaceholder() {
  const placeholder = document.createElement('div')
  placeholder.className = 'img-empty'
  placeholder.textContent = t('result.noImage')
  return placeholder
}

// 按物理坐标 + 缩放比画识别框（双索引联动）
function drawBoxes(img, s, si) {
  // 边界：图片已被占位替换 / 面板已移除 / 数据不完整 → 直接跳过
  if (!img || !img.parentElement || !img.parentElement.parentElement) return
  const imgPanel = img.parentElement.parentElement
  const boxLayer = imgPanel._boxLayer
  if (!boxLayer || !s || !Array.isArray(s.items)) return
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (!nw || !nh) return
  const maxW = Math.max(120, Math.min(imgPanel.clientWidth - 24, 640))
  const displayScale = nw > maxW ? maxW / nw : 1
  imgPanel._displayScale = displayScale
  img.style.width = Math.round(nw * displayScale) + 'px'
  img.style.height = Math.round(nh * displayScale) + 'px'

  boxLayer.innerHTML = ''
  s.items.forEach((it, i) => {
    if (!it.box) return
    const [x1, y1, x2, y2] = it.box
    const d = document.createElement('div')
    d.className = 'box'
    d.dataset.screen = si
    d.dataset.index = i
    d.style.left = Math.round(x1 * displayScale) + 'px'
    d.style.top = Math.round(y1 * displayScale) + 'px'
    d.style.width = Math.max(1, Math.round((x2 - x1) * displayScale)) + 'px'
    d.style.height = Math.max(1, Math.round((y2 - y1) * displayScale)) + 'px'
    d.addEventListener('mouseenter', () => hoverBox(si, i))
    d.addEventListener('mouseleave', () => unhoverBox(si, i))
    d.addEventListener('click', () => focusText(si, i))
    boxLayer.appendChild(d)
  })
}

function clearActive() {
  mainEl.querySelectorAll('.box.active').forEach((el) => el.classList.remove('active'))
  mainEl.querySelectorAll('.item.active').forEach((el) => el.classList.remove('active'))
}

const itemEl = (si, i) => mainEl.querySelector('.item[data-screen="' + si + '"][data-index="' + i + '"]')
const boxEl = (si, i) => mainEl.querySelector('.box[data-screen="' + si + '"][data-index="' + i + '"]')

function highlightBox(si, i, scroll) {
  const box = boxEl(si, i)
  if (!box) return
  box.classList.add('active')
  if (scroll !== false) box.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function highlightText(si, i, scroll) {
  const item = itemEl(si, i)
  if (!item) return
  item.classList.add('active')
  if (scroll !== false) item.scrollIntoView({ block: 'nearest' })
}

// 联动指向分两种：hover 是「临时指向」，点击才是「锁定」。
// 悬停不滚动面板——鼠标扫过识别框时文字区自己滚动，比不提示更让人困惑。
let hoverLink = null   // { si, i } 当前被悬停点亮
let pinnedLink = null  // { si, i } 被点击锁定

function hoverBox(si, i) {
  if (pinnedLink && pinnedLink.si === si && pinnedLink.i === i) return
  hoverLink = { si, i }
  highlightText(si, i, false)
}

// 指针离开就撤掉：否则联动底色会一直留着，看起来像「已选中」
function unhoverBox(si, i) {
  if (!hoverLink || hoverLink.si !== si || hoverLink.i !== i) return
  hoverLink = null
  if (pinnedLink && pinnedLink.si === si && pinnedLink.i === i) return
  const item = itemEl(si, i)
  if (item) item.classList.remove('active')
}

// 点击文字块 → 定位原图框（双向高亮）
function focusBox(si, i) {
  clearActive()
  pinnedLink = { si, i }
  hoverLink = null
  highlightText(si, i)
  highlightBox(si, i)
}

// 点击原图框 → 定位文字块
function focusText(si, i) {
  clearActive()
  pinnedLink = { si, i }
  hoverLink = null
  highlightBox(si, i)
  highlightText(si, i)
}

// 显示/隐藏识别框（所有屏）
toggleBoxes.addEventListener('change', () => {
  mainEl.querySelectorAll('.box-layer').forEach((l) => {
    l.style.display = toggleBoxes.checked ? 'block' : 'none'
  })
})

// 打开设置窗口
document.getElementById('btn-settings').addEventListener('click', () => {
  window.api.openSettings()
})

// 复制后自动关闭：切换时回写设置，保持与设置页一致
autoCloseEl.addEventListener('change', () => {
  window.api.setSettings({ autoCloseAfterCopy: autoCloseEl.checked })
})

// 拼装全文：多屏之间用屏名分隔
function getAllText() {
  return screens
    .map((s) => {
      const body = s.items.map((it) => it.text).join('\n')
      return s.label ? (s.label + '\n' + body) : body
    })
    .join('\n\n')
}

// —— 复制 ——
async function doCopy(text, msg, btn) {
  await window.api.copyText(text)
  if (btn) buttonFeedback(btn, t('result.copied'))
  if (autoCloseEl.checked) {
    setTimeout(() => window.api.closeResult(), 400)
  } else {
    flash(msg)
  }
}

function getSelectionText() {
  const s = window.getSelection()
  return s ? s.toString() : ''
}

// 全选：只选「识别文字」这一段，不含屏名、图区占位与工具栏。
// 不能直接 selectNodeContents(mainEl)：选区从非编辑区跨进编辑根后，
// Chromium 的 Selection.toString() 会返回空串，导致「复制选中」拿到空内容。
function selectAll() {
  const editors = mainEl.querySelectorAll('.editor')
  const s = window.getSelection()
  if (!s) return
  s.removeAllRanges()
  const withText = Array.prototype.filter.call(editors, (el) => el.textContent.length)
  if (!withText.length) return

  const first = withText[0]
  const last = withText[withText.length - 1]
  const range = document.createRange()
  range.setStartBefore(first.firstChild)
  range.setEndAfter(last.lastChild)
  s.addRange(range)
}

document.getElementById('btn-copy-all').addEventListener('click', async () => {
  await doCopy(getAllText(), t('result.copiedAll'), document.getElementById('btn-copy-all'))
})

document.getElementById('btn-copy-sel').addEventListener('click', async () => {
  const text = getSelectionText()
  if (!text) { flash(t('result.selectFirst')); return }
  await doCopy(text, t('result.copiedSel'), document.getElementById('btn-copy-sel'))
})

// —— 选区浮条 ——
// 选完文字后「复制」按钮在顶部工具栏，鼠标要跑一趟；浮条把动作放到指尖。
// 只在鼠标松开（pointer 交互）后出现，程序化选区不会触发，避免干扰自动化测试与截图。
const selPill = document.createElement('div')
selPill.className = 'sel-pill'
selPill.hidden = true

const selPillBtn = document.createElement('button')
selPillBtn.type = 'button'
selPillBtn.className = 'btn'
selPillBtn.dataset.i18n = 'result.copy'
selPillBtn.dataset.act = 'copy'
selPill.appendChild(selPillBtn)
document.body.appendChild(selPill)

// 选区必须落在结果内容区：在工具栏/图区拖出来的选区不该弹浮条
function selectionRangeInMain() {
  const s = window.getSelection()
  if (!s || s.isCollapsed || !s.rangeCount) return null
  const range = s.getRangeAt(0)
  return mainEl.contains(range.commonAncestorContainer) ? range : null
}

function hideSelectionPill() {
  if (!selPill.hidden) selPill.hidden = true
}

// 定位：默认贴选区末尾下方（不压住已选中的文字）；下方放不下再翻到上方，
// 并夹在内容区内 —— 浮条不能盖住工具栏，也不该贴着窗口边缘。
function placeSelectionPill(range) {
  selPill.hidden = false
  const rects = range.getClientRects()
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
  if (!rect || (!rect.width && !rect.height)) { hideSelectionPill(); return }

  const w = selPill.offsetWidth
  const h = selPill.offsetHeight
  const mainTop = mainEl.getBoundingClientRect().top + 4
  const maxTop = window.innerHeight - h - 8

  let top = rect.bottom + 8
  if (top > maxTop) top = rect.top - h - 8
  top = Math.max(mainTop, Math.min(top, maxTop))

  let left = rect.left + rect.width / 2 - w / 2
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  selPill.style.transform = 'translate(' + Math.round(left) + 'px, ' + Math.round(top) + 'px)'
}

// 拖选结束才出现；点击浮条自身时不要重新弹出
document.addEventListener('mouseup', (e) => {
  if (selPill.contains(e.target)) return
  requestAnimationFrame(() => {
    const range = selectionRangeInMain()
    if (range) placeSelectionPill(range)
    else hideSelectionPill()
  })
})

// 选区塌陷 / 滚动 / 窗口尺寸变化 → 收起（贴不住就宁可消失）
document.addEventListener('selectionchange', () => {
  const s = window.getSelection()
  if (!s || s.isCollapsed) {
    hideSelectionPill()
    // 之前因为「正在选字」而推迟的精修结果，选区收起后立刻换上
    if (deferredPayload) applyDeferred()
  }
})
mainEl.addEventListener('scroll', hideSelectionPill, true)
window.addEventListener('resize', hideSelectionPill)
document.addEventListener('pointerdown', (e) => {
  if (!selPill.contains(e.target)) hideSelectionPill()
})

// mousedown 阻止默认行为：点浮条时不丢选区（否则复制到空字符串）
selPill.addEventListener('mousedown', (e) => e.preventDefault())

selPillBtn.addEventListener('click', async () => {
  const text = getSelectionText()
  hideSelectionPill()
  if (!text) { flash(t('result.selectFirst')); return }
  await doCopy(text, t('result.copiedSel'))
})

// 键盘快捷键：Ctrl/Cmd+C 复制、Ctrl/Cmd+A 全选、Esc 关闭
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    const sel = getSelectionText()
    if (sel) doCopy(sel, t('result.copiedSel'))
    else doCopy(getAllText(), t('result.copiedAll'))
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectAll()
  } else if (e.key === 'Escape') {
    window.api.closeResult()
  }
})

// 首次打开：拉取结果
async function init() {
  // 先按当前语言渲染静态文案，避免首屏出现占位空白；随后用骨架屏占住内容区
  applyLanguage(window.api.initialLanguage)
  renderLoading()

  // 读取「复制后自动关闭」的默认值（设置页可改，结果页切换也会回写）
  try {
    const cfg = await window.api.getSettings()
    if (cfg && cfg.autoCloseAfterCopy !== undefined) {
      autoCloseEl.checked = cfg.autoCloseAfterCopy !== false
    }
  } catch (e) { /* 忽略：保持默认 checked */ }

  let result = null
  try {
    result = await window.api.getResult()
  } catch (e) {
    result = null // 取结果失败：走空状态，不能让窗口停在骨架屏
  }

  // 主进程还在识别：保持骨架屏，等 result:update 推结果过来。
  // 这里必须区分「还没来」和「确实没有」，否则会先闪一下"未识别到文字"。
  if (result && result.pending) return

  if (!result || !(result.screens && result.screens.length) && !(result.texts && result.texts.length)) {
    renderEmpty()
    return
  }
  render(result)
}

// 连续截图 / 精修完成：主进程推送新结果，直接刷新
window.api.onUpdate((payload) => {
  if (!payload || !((payload.screens && payload.screens.length) || (payload.texts && payload.texts.length))) return
  if (shouldDefer(payload)) { deferSwap(payload); return }
  render(payload)
})

// 精修结果到达时：如果用户正在拖选/已选中文字，先不换，否则文字会在光标下跳变
function hasLiveSelection() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false
  const node = sel.anchorNode
  return !!node && mainEl.contains(node)
}

function shouldDefer(payload) {
  // 只有「精修完成」的整段替换需要让路；换语言、连续截图更新等照常刷新
  return refining && payload.refined === true && hasLiveSelection()
}

function deferSwap(payload) {
  deferredPayload = payload
  clearTimeout(deferredTimer)
  // 兜底：用户长时间不松手也不能永远停在临时结果
  deferredTimer = setTimeout(applyDeferred, 20000)
}

function applyDeferred() {
  clearTimeout(deferredTimer)
  deferredTimer = 0
  if (!deferredPayload) return
  const payload = deferredPayload
  deferredPayload = null
  render(payload)
}

init()
