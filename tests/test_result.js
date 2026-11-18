// 结果页自检：多屏分组渲染 + 复制全文拼接 + 旧结构向后兼容 + 双向联动
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')
const RESULT = path.join(__dirname, '..', 'src', 'renderer', 'result.html')

let currentResult = null
let copiedText = null
let closeCount = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitNode(cond, name) {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return
    await sleep(50)
  }
  throw new Error('等待超时: ' + name)
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })
  await win.loadURL('data:text/html,<html></html>')

  ipcMain.handle('result:get', () => currentResult)
  ipcMain.handle('clipboard:copy', async (_e, text) => { copiedText = text })
  ipcMain.handle('result:close', async () => { closeCount++ })

  // 生成 2000x1000 纯色图作为截图
  const image = await win.webContents.executeJavaScript(`(function(){
    const c=document.createElement('canvas'); c.width=2000; c.height=1000;
    const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,2000,1000);
    return c.toDataURL('image/png');
  })()`)

  // —— 用例 A：多屏结构 ——
  currentResult = {
    screens: [
      { label: '主屏', image, texts: ['Hello', 'World'], boxes: [[0, 0, 1000, 500], [1000, 0, 2000, 500]], scores: [0.99, 0.98] },
      { label: '副屏 1', image, texts: ['你好世界'], boxes: [[0, 0, 2000, 1000]], scores: [0.97] }
    ]
  }
  await win.loadFile(RESULT)
  await waitNode(async () => {
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.screen-group').length`).catch(() => 0)
    return n >= 2
  }, '多屏渲染')

  const multi = await win.webContents.executeJavaScript(`(function(){
    const groups = document.querySelectorAll('.screen-group');
    const titles = Array.from(groups).map(g => g.querySelector('.screen-title').textContent);
    const items = Array.from(groups).map(g => g.querySelectorAll('.item').length);
    const boxes = Array.from(groups).map(g => g.querySelectorAll('.box').length);
    return { groupCount: groups.length, titles, items, boxes };
  })()`)
  console.log('[OK] 分组数:', multi.groupCount, '(期望 2), 标题:', JSON.stringify(multi.titles))
  console.log('[OK] 各屏文字块数:', JSON.stringify(multi.items), '(期望 [2,1])')
  console.log('[OK] 各屏识别框数:', JSON.stringify(multi.boxes), '(期望 [2,1])')
  const multiOk =
    multi.groupCount === 2 &&
    multi.titles[0] === '主屏' && multi.titles[1] === '副屏 1' &&
    multi.items[0] === 2 && multi.items[1] === 1 &&
    multi.boxes[0] === 2 && multi.boxes[1] === 1

  // 复制全文：只含识别文字，不能带屏名（"主屏"/"Display 1" 之类都是界面标题）
  await win.webContents.executeJavaScript(`document.getElementById('btn-copy-all').click()`)
  await waitNode(() => copiedText !== null, '复制全文')
  console.log('[OK] 复制全文内容:', JSON.stringify(copiedText))
  const copyOk = copiedText === 'Hello\nWorld\n你好世界'
  console.log(copyOk ? '[PASS] 复制全文无屏名前缀' : '[FAIL] 复制全文含多余内容')

  // 双向联动（第 1 屏）
  const link = await win.webContents.executeJavaScript(`(function(){
    const g = document.querySelectorAll('.screen-group')[0];
    const item = g.querySelectorAll('.item')[0];
    const box = g.querySelectorAll('.box')[0];
    item.click();
    const t2b = box.classList.contains('active');
    document.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));
    box.click();
    const b2t = item.classList.contains('active');
    return { t2b, b2t };
  })()`)
  console.log('[OK] 多屏双向联动:', JSON.stringify(link))

  // —— 多选：单击切换选中状态（无需修饰键）——
  await sleep(400) // 超出双击判定窗口，保证下面的 click 都是独立的单击
  const multiSel = await win.webContents.executeJavaScript(`(function(){
    document.getElementById('auto-close').checked = false;
    const g = document.querySelectorAll('.screen-group')[0];
    const items = g.querySelectorAll('.item');
    items[0].click();
    const one = g.querySelectorAll('.item.selected').length;
    const boxLit = g.querySelectorAll('.box.selected').length;
    items[1].click();
    const two = g.querySelectorAll('.item.selected').length;
    items[0].click();
    const back = g.querySelectorAll('.item.selected').length;
    const restText = (g.querySelector('.item.selected') || {}).textContent || '';
    return { one, boxLit, two, back, restText };
  })()`)
  console.log('[OK] 单击多选:', JSON.stringify(multiSel), '(期望 1/1/2/1, 剩 "World")')
  const multiSelOk = multiSel.one === 1 && multiSel.boxLit === 1 && multiSel.two === 2 &&
    multiSel.back === 1 && multiSel.restText === 'World'

  // 「复制选中」按多选行取内容（没有划选文字时）
  copiedText = null
  await win.webContents.executeJavaScript(`document.getElementById('btn-copy-sel').click()`)
  await waitNode(() => copiedText !== null, '复制选中（多选）')
  console.log('[OK] 多选后复制选中:', JSON.stringify(copiedText), '(期望 "World")')
  const selCopyOk = copiedText === 'World'

  // —— 双击：复制该行，且不改变已有的多选状态（click + click + dblclick）——
  await sleep(400)
  copiedText = null
  const dblState = await win.webContents.executeJavaScript(`(function(){
    const g = document.querySelectorAll('.screen-group')[0];
    const item = g.querySelectorAll('.item')[0];
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { selected: g.querySelectorAll('.item.selected').length };
  })()`)
  await waitNode(() => copiedText !== null, '双击复制该行')
  console.log('[OK] 双击复制该行:', JSON.stringify(copiedText), '| 多选数不变:', dblState.selected)
  const dblOk = copiedText === 'Hello' && dblState.selected === 1

  // 双击右侧原图的识别框：复制对应行
  copiedText = null
  await win.webContents.executeJavaScript(`(function(){
    const g = document.querySelectorAll('.screen-group')[0];
    const box = g.querySelectorAll('.box')[0];
    box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`)
  await waitNode(() => copiedText !== null, '双击识别框复制')
  console.log('[OK] 双击识别框复制:', JSON.stringify(copiedText), '(期望 "Hello")')
  const dblBoxOk = copiedText === 'Hello'

  // —— 用例 B：旧单屏结构向后兼容 ——
  copiedText = null
  currentResult = { texts: ['Hello', 'World', '你好世界'], boxes: [[0, 0, 1000, 500], [1000, 0, 2000, 500], [0, 500, 2000, 1000]], scores: [0.99, 0.98, 0.97], image }
  await win.loadFile(RESULT)
  await waitNode(async () => {
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.screen-group').length`).catch(() => 0)
    return n >= 1
  }, '旧结构渲染')

  const legacy = await win.webContents.executeJavaScript(`(function(){
    const items = document.querySelectorAll('.item').length;
    const boxes = document.querySelectorAll('.box').length;
    return { items, boxes };
  })()`)
  console.log('[OK] 旧结构兼容：文字块', legacy.items, '(期望 3), 识别框', legacy.boxes, '(期望 3)')
  const legacyOk = legacy.items === 3 && legacy.boxes === 3

  const ok = multiSelOk && selCopyOk && dblOk && dblBoxOk && copyOk && link.t2b && link.b2t && legacyOk
  console.log(ok ? '[PASS] 结果页多屏分组 + 兼容性正确' : '[FAIL] 结果页异常')
  if (!ok) process.exitCode = 1
  app.quit()
})

app.on('window-all-closed', () => app.quit())
