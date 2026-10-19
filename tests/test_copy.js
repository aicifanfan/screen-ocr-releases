// M4 复制交互自检：复制全文 / 连续截图刷新 / Ctrl+A 全选 / 复制后自动关闭
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'index.js')
const RESULT = path.join(__dirname, '..', 'src', 'renderer', 'result.html')

let copiedText = null
let win = null

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

app.whenReady().then(async () => {
  let closeRequested = false

  win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  })

  // 捕获复制内容（不依赖系统剪贴板）
  ipcMain.handle('clipboard:copy', (_e, text) => { copiedText = text; return text })
  // 记录"关闭结果窗口"请求（真正 win.close() 由 Electron 保证，单测只验证触发）
  ipcMain.handle('result:close', () => { closeRequested = true; return true })

  await win.loadURL('data:text/html,<html></html>')
  const image = await win.webContents.executeJavaScript(`(function(){
    const c=document.createElement('canvas'); c.width=100; c.height=50;
    const x=c.getContext('2d'); x.fillStyle='#fff'; x.fillRect(0,0,100,50);
    return c.toDataURL('image/png');
  })()`)

  const data = { texts: ['Hello', 'World', '你好'], boxes: [[0, 0, 50, 25], [50, 0, 100, 25], [0, 25, 100, 50]], scores: [1, 1, 1], image }
  ipcMain.handle('result:get', () => data)
  await win.loadFile(RESULT)
  await waitReady(win)

  // 测试1：复制全文（先取消 auto-close，避免关闭窗口）
  await win.webContents.executeJavaScript(`(function(){
    document.getElementById('auto-close').checked = false;
    document.getElementById('btn-copy-all').click();
  })()`)
  await sleep(150)
  const btnText = await win.webContents.executeJavaScript(`document.getElementById('btn-copy-all').textContent`)
  const copyAll = copiedText
  console.log('[OK] 复制按钮反馈文字:', JSON.stringify(btnText), '(期望 "已复制✓")')
  console.log('[OK] 复制全文内容:', JSON.stringify(copyAll))

  // 测试2：连续截图刷新（onUpdate 推送新结果）
  const data2 = { texts: ['New1', 'New2'], boxes: [[0, 0, 50, 25], [0, 25, 50, 50]], scores: [1, 1], image }
  win.webContents.send('result:update', data2)
  await sleep(200)
  const itemCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.item').length`)
  const firstNew = await win.webContents.executeJavaScript(`document.querySelectorAll('.item')[0].textContent`)
  console.log('[OK] onUpdate 后文字块数:', itemCount, '(期望 2)')
  console.log('[OK] onUpdate 后首行:', JSON.stringify(firstNew), '(期望 "New1")')

  // 测试3：Ctrl+A 全选
  const sel = await win.webContents.executeJavaScript(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'a', ctrlKey:true, bubbles:true}));
    return window.getSelection().toString();
  })()`)
  console.log('[OK] Ctrl+A 选中文本:', JSON.stringify(sel), '(期望含 New1/New2)')

  // 测试4：复制后自动关闭（勾选 auto-close）
  await win.webContents.executeJavaScript(`(function(){
    document.getElementById('auto-close').checked = true;
    document.getElementById('btn-copy-all').click();
  })()`)
  await sleep(900)
  console.log('[OK] 复制后触发关闭请求:', closeRequested ? 'PASS' : 'FAIL')

  const ok =
    btnText === '已复制✓' &&
    copyAll && copyAll.includes('Hello') && copyAll.includes('你好') &&
    itemCount === 2 && firstNew === 'New1' &&
    sel && sel.includes('New1') && sel.includes('New2') &&
    closeRequested

  console.log(ok ? '[PASS] 复制交互（复制/刷新/全选/自动关闭）正常' : '[FAIL] 复制交互异常')
  if (!ok) process.exitCode = 1
  app.quit()
})

async function waitReady(win) {
  for (let i = 0; i < 100; i++) {
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('.item').length`)
    if (n > 0) return
    await sleep(50)
  }
  throw new Error('结果页渲染超时')
}

app.on('window-all-closed', () => app.quit())
