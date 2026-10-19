// 结果页视觉/交互验证：选区对比度、三态可区分、选中计数、复制按钮可用态、窄屏堆叠
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')
const RESULT = path.join(__dirname, '..', 'src', 'renderer', 'result.html')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = true
function check(name, ok, detail) {
  if (!ok) pass = false
  console.log((ok ? '[OK]   ' : '[FAIL] ') + name + (detail ? '  ' + detail : ''))
}

// WCAG 相对亮度对比度（在测试进程内算，避免依赖页面环境）
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const l1 = lum(a), l2 = lum(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}
const parseRGB = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number)

// 轮询等待页面条件成立：隐藏窗口下 resize 的传播是异步的，固定 sleep 会偶发失败
async function waitFor(win, expr, timeout = 2500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await win.webContents.executeJavaScript(expr).catch(() => false)
    if (ok) return true
    await sleep(60)
  }
  return false
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=zh'] }
  })
  await win.loadURL('data:text/html,<html></html>')

  const image = await win.webContents.executeJavaScript(`(function(){
    const c=document.createElement('canvas'); c.width=600; c.height=200;
    const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,600,200);
    x.fillStyle='#000'; x.font='20px sans-serif'; x.fillText('Hello World', 20, 60);
    x.fillText('第二行文本', 20, 110);
    return c.toDataURL('image/png');
  })()`)

  const texts = ['Hello World', '第二行文本', 'Invoice No. A-2024-001']
  ipcMain.handle('result:get', () => ({
    screens: [{ label: '', image, texts, boxes: [[0, 0, 300, 100], [0, 100, 300, 200], [300, 0, 600, 100]], scores: [0.99, 0.98, 0.97] }]
  }))
  ipcMain.handle('settings:get', () => ({ autoCloseAfterCopy: false }))
  ipcMain.handle('clipboard:copy', async () => {})

  await win.loadFile(RESULT)
  await sleep(700)

  // —— 1. ::selection 规则与对比度 ——
  const sel = await win.webContents.executeJavaScript(`(function(){
    const root = getComputedStyle(document.documentElement);
    const bg = root.getPropertyValue('--sel-bg').trim();
    const fg = root.getPropertyValue('--sel-text').trim();
    // 从样式表里确认 ::selection 真的被声明（getComputedStyle 无法查询伪元素）
    let declared = false;
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules } catch(e) { continue }
      for (const r of rules) if (r.selectorText === '::selection') declared = true;
    }
    const hex = (h) => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.slice(i,i+2),16)); };
    return { declared, bg, fg, bgRGB: hex(bg), fgRGB: hex(fg) };
  })()`)

  check('::selection 规则已声明', sel.declared === true)
  const ratio = contrast(sel.bgRGB, sel.fgRGB)
  check('选区文字对比度 ≥ 4.5:1 (WCAG AA)', ratio >= 4.5, '=' + ratio.toFixed(2) + ':1')

  // 选区底色与白底要有可见差异（不能"看起来没选中"）
  const bgDiff = contrast(sel.bgRGB, [255, 255, 255])
  check('选区底色与白底可辨识', bgDiff > 1.12 && bgDiff < 2.2, '对比 ' + bgDiff.toFixed(2) + ':1')

  // —— 2. 初始态：未选中 → 复制选中禁用、状态条为空 ——
  const idle = await win.webContents.executeJavaScript(`(function(){
    return {
      disabled: document.getElementById('btn-copy-sel').disabled,
      status: document.getElementById('status').textContent.trim()
    };
  })()`)
  check('未选中时「复制选中」禁用', idle.disabled === true)
  check('未选中时状态条为空', idle.status === '', JSON.stringify(idle.status))

  // —— 3. 选中文字 → 计数 + 按钮启用 ——
  const selected = await win.webContents.executeJavaScript(`(function(){
    const item = document.querySelectorAll('.item')[0];
    const r = document.createRange(); r.selectNodeContents(item);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    return true;
  })()`)
  await sleep(250)
  const afterSel = await win.webContents.executeJavaScript(`(function(){
    const st = document.getElementById('status');
    return {
      disabled: document.getElementById('btn-copy-sel').disabled,
      status: st.textContent.trim(),
      isCount: st.classList.contains('is-count'),
      count: window.getSelection().toString().trim().length
    };
  })()`)
  check('选中后「复制选中」启用', afterSel.disabled === false)
  check('状态条显示选中字数', afterSel.status.includes(String(afterSel.count)), JSON.stringify(afterSel.status))
  check('状态条带计数样式（is-count）', afterSel.isCount === true)

  // —— 4. 清除选区 → 回到禁用 ——
  await win.webContents.executeJavaScript(`window.getSelection().removeAllRanges()`)
  await sleep(250)
  const afterClear = await win.webContents.executeJavaScript(`(function(){
    return { disabled: document.getElementById('btn-copy-sel').disabled, status: document.getElementById('status').textContent.trim() };
  })()`)
  check('清除选区后恢复禁用', afterClear.disabled === true)
  check('清除选区后状态条清空', afterClear.status === '')

  // —— 5. 三态可区分：联动高亮 / 识别框 / 选区 ——
  const states = await win.webContents.executeJavaScript(`(function(){
    const item = document.querySelectorAll('.item')[1];
    const box = document.querySelectorAll('.box')[1];
    item.click();
    const cs = getComputedStyle(item);
    const bs = getComputedStyle(box);
    return {
      itemBg: cs.backgroundColor,
      itemShadow: cs.boxShadow,
      boxBorder: bs.borderColor,
      boxWidth: bs.borderTopWidth,
      selBg: getComputedStyle(document.documentElement).getPropertyValue('--sel-bg').trim()
    };
  })()`)
  // 联动高亮的背景必须比选区底色更淡（否则用户分不清"我选中的"和"系统指向的"）
  const itemRGB = parseRGB(states.itemBg)
  const linkVsSel = contrast(itemRGB, sel.bgRGB)
  check('联动高亮底 ≠ 选区底（层级清晰）', linkVsSel > 1.05, '对比 ' + linkVsSel.toFixed(2) + ':1')
  check('联动高亮带左侧色条', /inset/.test(states.itemShadow) && !/none/.test(states.itemShadow), states.itemShadow)
  // 识别框 active 用主色系，不用红色（红色语义是"错误"）
  const boxRGB = parseRGB(states.boxBorder)
  check('识别框激活色非红色系', !(boxRGB[0] > 200 && boxRGB[1] < 120), JSON.stringify(boxRGB))
  check('识别框激活加粗到 2px', states.boxWidth === '2px', states.boxWidth)

  // —— 5b. 悬停识别框是「临时指向」：指针离开后高亮撤掉，点击锁定的保留 ——
  const hoverLink = await win.webContents.executeJavaScript(`(function(){
    const box = document.querySelectorAll('.box')[0];
    box.dispatchEvent(new MouseEvent('mouseenter'));
    const during = document.querySelectorAll('.item.active').length;
    box.dispatchEvent(new MouseEvent('mouseleave'));
    return { during, after: document.querySelectorAll('.item.active').length };
  })()`)
  check('悬停时临时点亮对应文字行', hoverLink.during >= 2, hoverLink.during + ' 行')
  check('指针离开后撤掉悬停高亮（保留点击锁定）', hoverLink.after === 1, hoverLink.after + ' 行')

  // —— 6. 文字块纵向 padding 为 0（多行选中高亮不断裂） ——
  const itemPad = await win.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector('.item')).paddingTop`)
  check('文字块 padding-top=0（跨行选区连续）', itemPad === '0px', itemPad)

  // —— 6b. 结构契约：单一编辑根、行节点一一对应、非文本区不可选 ——
  const struct = await win.webContents.executeJavaScript(`(function(){
    return {
      panels: document.querySelectorAll('.text-panel').length,
      hosts: document.querySelectorAll('.text-panel [contenteditable="true"]').length,
      editors: document.querySelectorAll('.editor').length,
      lines: document.querySelectorAll('.editor > .item').length,
      inheritsEditable: document.querySelector('.item').isContentEditable,
      toolbarSelect: getComputedStyle(document.querySelector('.toolbar')).userSelect,
      imgSelect: getComputedStyle(document.querySelector('.img-panel')).userSelect
    };
  })()`)
  // 多个编辑主机会让 Blink 把拖选钳制在首行，这里锁死为「每面板一个编辑根」
  check('每个文字面板仅 1 个编辑根', struct.panels > 0 && struct.hosts === struct.panels && struct.editors === struct.panels,
    `panels=${struct.panels} hosts=${struct.hosts} editors=${struct.editors}`)
  check('行节点仍可编辑且结构保留', struct.lines > 0 && struct.inheritsEditable === true, struct.lines + ' 行')
  check('工具栏与图区不可被划选', struct.toolbarSelect === 'none' && struct.imgSelect === 'none',
    struct.toolbarSelect + '/' + struct.imgSelect)

  // —— 7. 桌面宽度：左右分栏；无横向溢出 ——
  await win.setContentSize(1000, 800)
  await waitFor(win, `window.innerWidth > 900 && !matchMedia('(max-width: 760px)').matches`)
  const wide = await win.webContents.executeJavaScript(`(function(){
    const body = document.querySelector('.screen-body');
    return {
      dir: getComputedStyle(body).flexDirection,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`)
  check('宽屏为左右分栏', wide.dir === 'row', wide.dir)
  check('宽屏无横向溢出', wide.overflowX === false)

  // —— 8. 窄屏：上下堆叠 + 触摸目标加大 + 无溢出 ——
  await win.setContentSize(700, 800)
  await waitFor(win, `matchMedia('(max-width: 760px)').matches`)
  const narrow = await win.webContents.executeJavaScript(`(function(){
    const body = document.querySelector('.screen-body');
    const btn = document.getElementById('btn-copy-all');
    return {
      dir: getComputedStyle(body).flexDirection,
      btnH: btn.getBoundingClientRect().height,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  })()`)
  check('窄屏改为上下堆叠', narrow.dir === 'column', narrow.dir)
  check('窄屏按钮高度 ≥ 36px（触摸友好）', narrow.btnH >= 36, narrow.btnH + 'px')
  check('窄屏无横向溢出', narrow.overflowX === false)

  // —— 9. 工具栏换行时内容区不被挤压（弹性布局，非硬编码高度） ——
  const layout = await win.webContents.executeJavaScript(`(function(){
    const tb = document.querySelector('.toolbar').getBoundingClientRect();
    const main = document.getElementById('main').getBoundingClientRect();
    return { gap: Math.round(main.top - tb.bottom), mainH: Math.round(main.height) };
  })()`)
  check('内容区紧接工具栏（无硬编码高度错位）', Math.abs(layout.gap) <= 1, 'gap=' + layout.gap + 'px')
  check('内容区高度有效', layout.mainH > 100, layout.mainH + 'px')

  // —— 10. 复制反馈：文案变化不应改变按钮宽度（工具栏不抖动） ——
  const feedback = await win.webContents.executeJavaScript(`(async function(){
    const btn = document.getElementById('btn-copy-all');
    const before = btn.getBoundingClientRect().width;
    btn.click();
    await new Promise((r) => setTimeout(r, 120));
    const during = btn.getBoundingClientRect().width;
    const label = btn.textContent;
    const done = btn.classList.contains('is-done');
    await new Promise((r) => setTimeout(r, 1300));
    return { before, during, label, done, restored: btn.textContent };
  })()`)
  check('复制后出现成功态', feedback.done === true, feedback.label)
  check('复制反馈不改变按钮宽度', Math.abs(feedback.during - feedback.before) <= 1,
    feedback.before.toFixed(1) + 'px → ' + feedback.during.toFixed(1) + 'px')
  check('反馈结束后文案还原', feedback.restored !== feedback.label, feedback.restored)

  // —— 10b. Ctrl+A 只选中识别文字，且「复制选中」能取到 ——
  const selectAllState = await win.webContents.executeJavaScript(`(async function(){
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    const s = window.getSelection();
    return { text: s ? s.toString() : '', disabled: document.getElementById('btn-copy-sel').disabled };
  })()`)
  check('Ctrl+A 选中全部识别文字',
    /Hello World/.test(selectAllState.text) && /Invoice/.test(selectAllState.text),
    JSON.stringify(selectAllState.text.slice(0, 24)))
  check('Ctrl+A 后「复制选中」可用', selectAllState.disabled === false)

  // —— 11. 加载骨架 / 空状态 / 无原图占位 ——
  const spawn = async () => {
    const w = new BrowserWindow({
      show: false, width: 900, height: 700,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=zh'] }
    })
    await w.loadFile(RESULT)
    return w
  }

  ipcMain.removeHandler('result:get')
  ipcMain.handle('result:get', () => new Promise((resolve) => setTimeout(() => resolve({
    screens: [{ label: '', image: '', texts: ['加载完成后的第一行'], boxes: [], scores: [] }]
  }), 600)))
  const winLoading = await spawn()
  await waitFor(winLoading, `!!document.querySelector('.skeleton')`)
  const loading = await winLoading.webContents.executeJavaScript(`({
    skeleton: !!document.querySelector('.skeleton'),
    lines: document.querySelectorAll('.skeleton-line').length,
    busy: document.getElementById('main').getAttribute('aria-busy')
  })`)
  check('拉取结果期间显示骨架屏', loading.skeleton && loading.lines > 0, loading.lines + ' 行')
  check('加载态 aria-busy=true', loading.busy === 'true', loading.busy)

  await waitFor(winLoading, `document.querySelectorAll('.item').length > 0`)
  const loaded = await winLoading.webContents.executeJavaScript(`({
    skeleton: !!document.querySelector('.skeleton'),
    busy: document.getElementById('main').getAttribute('aria-busy'),
    imgEmpty: (document.querySelector('.img-empty') || {}).textContent || ''
  })`)
  check('数据到达后移除骨架并复位 aria-busy', loaded.skeleton === false && loaded.busy === 'false',
    loaded.busy)
  check('无原图时右侧显示占位', loaded.imgEmpty.length > 0, loaded.imgEmpty)

  ipcMain.removeHandler('result:get')
  ipcMain.handle('result:get', () => ({ screens: [] }))
  const winEmpty = await spawn()
  await waitFor(winEmpty, `document.getElementById('main').getAttribute('aria-busy') === 'false' && !!document.querySelector('.empty')`)
  const empty = await winEmpty.webContents.executeJavaScript(`({
    text: (document.querySelector('.empty') || {}).textContent || '',
    hint: (document.querySelector('.empty-hint') || {}).textContent || '',
    icon: !!document.querySelector('.empty-icon svg'),
    busy: document.getElementById('main').getAttribute('aria-busy')
  })`)
  check('空状态文案（.empty 精确匹配）', empty.text === '（未识别到文字）', JSON.stringify(empty.text))
  check('空状态含图标与补充提示', empty.icon === true && empty.hint.length > 0, empty.hint)
  check('空状态结束加载态', empty.busy === 'false', empty.busy)

  console.log(pass ? '[ALL PASS] 结果页视觉与交互验证通过' : '[FAIL] 存在未通过项')
  if (!pass) process.exitCode = 1
  app.quit()
})

app.on('window-all-closed', () => app.quit())
