// 结果页逻辑：多屏分组展示 + 可编辑文字块 + 原图对照（双向联动）+ 复制交互
const mainEl = document.getElementById('main')
const statusEl = document.getElementById('status')
const toggleBoxes = document.getElementById('toggle-boxes')
const autoCloseEl = document.getElementById('auto-close')

let screens = [] // [{ label, image, items: [{ text, box, score }] }]

function flash(msg) {
  statusEl.textContent = msg
  setTimeout(() => { statusEl.textContent = '' }, 1500)
}

function buttonFeedback(btn, text) {
  const orig = btn.textContent
  btn.textContent = text
  btn.classList.add('done')
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('done') }, 1200)
}

// 核心：根据结果渲染（首次打开与连续截图刷新共用）
// 兼容两种结构：{ screens:[{label,image,texts,boxes,scores}] } 或旧 { texts,boxes,scores,image }
function render(result) {
  const raw = result.screens || [{
    label: result.label || '',
    image: result.image,
    texts: result.texts || [],
    boxes: result.boxes,
    scores: result.scores
  }]

  screens = raw.map((s) => {
    const items = (s.texts || []).map((t, i) => ({
      text: t,
      box: s.boxes && s.boxes[i] ? s.boxes[i] : null,
      score: s.scores && s.scores[i] != null ? s.scores[i] : null
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
    return { label: s.label || '', image: s.image, items }
  })

  renderAll()
}

function renderAll() {
  mainEl.innerHTML = ''
  // 仅多屏时显示标题（单屏无需区分来源）
  const showTitle = screens.length > 1
  screens.forEach((s, si) => renderScreen(s, si, showTitle))
}

// 渲染单屏分组：标题（多屏时）+ 左文字 + 右原图
function renderScreen(s, si, showTitle) {
  const group = document.createElement('div')
  group.className = 'screen-group'

  if (showTitle) {
    const title = document.createElement('div')
    title.className = 'screen-title'
    title.textContent = s.label || ('屏幕 ' + (si + 1))
    group.appendChild(title)
  }

  const body = document.createElement('div')
  body.className = 'screen-body'

  // 左：文字块
  const textPanel = document.createElement('div')
  textPanel.className = 'text-panel'
  s.items.forEach((it, i) => {
    const div = document.createElement('div')
    div.className = 'item'
    div.contentEditable = 'true'
    div.textContent = it.text
    div.dataset.screen = si
    div.dataset.index = i
    if (it.score != null) div.title = '置信度 ' + Math.round(it.score * 100) + '%'
    div.addEventListener('click', () => focusBox(si, i))
    div.addEventListener('input', () => { it.text = div.textContent })
    textPanel.appendChild(div)
  })
  if (!s.items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '（未识别到文字）'
    textPanel.appendChild(empty)
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
    img.alt = '截图'
    img.onload = () => drawBoxes(img, s, si)
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
  }
  body.appendChild(imgPanel)

  group.appendChild(body)
  mainEl.appendChild(group)
}

// 按物理坐标 + 缩放比画识别框（双索引联动）
function drawBoxes(img, s, si) {
  const imgPanel = img.parentElement.parentElement
  const boxLayer = imgPanel._boxLayer
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
    d.addEventListener('mouseenter', () => highlightText(si, i))
    d.addEventListener('click', () => focusText(si, i))
    boxLayer.appendChild(d)
  })
}

function clearActive() {
  mainEl.querySelectorAll('.box.active').forEach((el) => el.classList.remove('active'))
  mainEl.querySelectorAll('.item.active').forEach((el) => el.classList.remove('active'))
}

function highlightBox(si, i) {
  const box = mainEl.querySelector('.box[data-screen="' + si + '"][data-index="' + i + '"]')
  if (box) { box.classList.add('active'); box.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
}

function highlightText(si, i) {
  const item = mainEl.querySelector('.item[data-screen="' + si + '"][data-index="' + i + '"]')
  if (item) { item.classList.add('active'); item.scrollIntoView({ block: 'nearest' }) }
}

// 点击文字块 → 定位原图框（双向高亮）
function focusBox(si, i) {
  clearActive()
  highlightText(si, i)
  highlightBox(si, i)
}

// 点击/悬停原图框 → 定位文字块
function focusText(si, i) {
  clearActive()
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
  if (btn) buttonFeedback(btn, '已复制✓')
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

function selectAll() {
  const range = document.createRange()
  range.selectNodeContents(mainEl)
  const s = window.getSelection()
  s.removeAllRanges()
  s.addRange(range)
}

document.getElementById('btn-copy-all').addEventListener('click', async () => {
  await doCopy(getAllText(), '已复制全文', document.getElementById('btn-copy-all'))
})

document.getElementById('btn-copy-sel').addEventListener('click', async () => {
  const text = getSelectionText()
  if (!text) { flash('请先划选文字'); return }
  await doCopy(text, '已复制选中内容', document.getElementById('btn-copy-sel'))
})

// 键盘快捷键：Ctrl/Cmd+C 复制、Ctrl/Cmd+A 全选、Esc 关闭
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    const sel = getSelectionText()
    if (sel) doCopy(sel, '已复制选中内容')
    else doCopy(getAllText(), '已复制全文')
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectAll()
  } else if (e.key === 'Escape') {
    window.api.closeResult()
  }
})

// 首次打开：拉取结果
async function init() {
  // 读取「复制后自动关闭」的默认值（设置页可改，结果页切换也会回写）
  try {
    const cfg = await window.api.getSettings()
    if (cfg && cfg.autoCloseAfterCopy !== undefined) {
      autoCloseEl.checked = cfg.autoCloseAfterCopy !== false
    }
  } catch (e) { /* 忽略：保持默认 checked */ }

  const result = await window.api.getResult()
  if (!result || !(result.screens && result.screens.length) && !(result.texts && result.texts.length)) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '（未识别到文字）'
    mainEl.appendChild(empty)
    return
  }
  render(result)
}

// 连续截图：主进程推送新结果，直接刷新
window.api.onUpdate((payload) => {
  if (payload && ((payload.screens && payload.screens.length) || (payload.texts && payload.texts.length))) {
    render(payload)
  }
})

init()
