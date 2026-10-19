// 中英切换 UI 测试：真实 Electron 渲染进程 + 真实 preload
// 覆盖：首次语言、即时切换（无刷新）、全量文案、无中文残留、长文案不撑破布局
// 运行：npx electron test_i18n_ui.js --no-sandbox
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const PRELOAD = path.join(__dirname, 'src', 'preload', 'index.js')
const SETTINGS = path.join(__dirname, 'src', 'renderer', 'settings.html')
const RESULT = path.join(__dirname, 'src', 'renderer', 'result.html')

const CJK = /[\u4e00-\u9fff]/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let langSetting = 'auto'
let currentLang = 'zh'

function broadcast(lang, setting) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('i18n:changed', { lang, setting })
  }
}

// —— mock 主进程 IPC ——
ipcMain.handle('i18n:set', (_e, setting) => {
  langSetting = setting
  currentLang = setting === 'en' ? 'en' : 'zh'
  broadcast(currentLang, langSetting)
  return { ok: true, lang: currentLang, setting: langSetting }
})
ipcMain.handle('settings:get', () => ({
  shortcut: 'CommandOrControl+Shift+A', autoLaunch: false, captureOnLaunch: false,
  autoCloseAfterCopy: true, autoCheckUpdate: true, disableGpu: true,
  ocrProfile: 'balanced', language: langSetting
}))
ipcMain.handle('settings:set', () => ({ ok: true }))
ipcMain.handle('settings:close', () => {})
ipcMain.handle('settings:open', () => {})
ipcMain.handle('app:version', () => '0.1.1')
ipcMain.handle('update:check', () => {})
ipcMain.handle('clipboard:copy', () => {})
ipcMain.handle('result:close', () => {})
ipcMain.handle('result:get', () => ({
  screens: [
    {
      labelKind: 'primary', labelIndex: 0, image: '',
      texts: ['订单号 A20241019', '金额 ￥1,280.00'],
      boxes: [[10, 10, 200, 30], [10, 40, 200, 60]],
      scores: [0.97, 0.88]
    },
    {
      labelKind: 'secondary', labelIndex: 1, image: '',
      texts: [], boxes: [], scores: []
    }
  ]
}))

// —— 采集页面状态 ——
async function snapshot(win, extra) {
  return win.webContents.executeJavaScript(`(function(){
    const visibleText = document.body.innerText;
    // 只检查「界面文案」：排除识别结果正文（.item）、语言下拉里的语言自称、脚本/样式
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, .item, #opt-language').forEach(e => e.remove());
    const uiText = clone.textContent;
    const rows = Array.from(document.querySelectorAll('.row'));
    const docEl = document.documentElement;
    return Object.assign({
      title: document.title,
      htmlLang: docEl.lang,
      visibleText: visibleText,
      hasCJK: ${CJK}.test(uiText),
      cjkSample: (uiText.match(${CJK}) ? uiText.split('\\n').filter(l => ${CJK}.test(l)).slice(0,3) : []),
      overflowX: docEl.scrollWidth - docEl.clientWidth,
      rowOverflow: rows.filter(r => r.scrollWidth > r.clientWidth + 1).map(r => r.innerText.slice(0, 40)),
      toolbarOverflow: (function(){
        const tb = document.querySelector('.toolbar');
        return tb ? tb.scrollWidth - tb.clientWidth : 0;
      })()
    }, ${JSON.stringify(extra || {})}, {
      headerTitle: (document.querySelector('.header h1') || {}).textContent || '',
      saveText: (document.getElementById('btn-save') || {}).textContent || '',
      cancelText: (document.getElementById('btn-cancel') || {}).textContent || '',
      langValue: (document.getElementById('opt-language') || {}).value || '',
      ocrOptions: Array.from(document.querySelectorAll('#opt-ocr-profile option')).map(o => o.textContent),
      copyAll: (document.getElementById('btn-copy-all') || {}).textContent || '',
      copySel: (document.getElementById('btn-copy-sel') || {}).textContent || '',
      screenTitles: Array.from(document.querySelectorAll('.screen-title')).map(e => e.textContent),
      emptyTexts: Array.from(document.querySelectorAll('.empty')).map(e => e.textContent),
      statusText: (document.getElementById('status') || {}).textContent || ''
    });
  })()`)
}

async function waitFor(win, expr, timeout = 6000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ok = await win.webContents.executeJavaScript(expr).catch(() => false)
    if (ok) return true
    await sleep(100)
  }
  return false
}

let failed = 0
function check(name, cond, detail) {
  if (cond) console.log('  [OK]   ' + name)
  else { failed++; console.log('  [FAIL] ' + name + (detail ? '  → ' + detail : '')) }
}

app.whenReady().then(async () => {
  try {
    // ===================== 设置页 =====================
    const settingsWin = new BrowserWindow({
      show: false, width: 540, height: 640,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=' + currentLang] }
    })
    await settingsWin.loadFile(SETTINGS)
    await waitFor(settingsWin, `document.querySelector('.header h1').textContent === '截屏 OCR 设置'`)

    console.log('\n== 设置页：默认语言（中文）==')
    const zh = await snapshot(settingsWin)
    check('窗口标题为中文', zh.title === '设置 — 截屏 OCR', zh.title)
    check('html lang = zh-CN', zh.htmlLang === 'zh-CN', zh.htmlLang)
    check('标题文案', zh.headerTitle === '截屏 OCR 设置', zh.headerTitle)
    check('语言下拉显示配置值 auto', zh.langValue === 'auto', zh.langValue)
    check('识别精度选项为中文', JSON.stringify(zh.ocrOptions) === JSON.stringify(['快速', '均衡', '高精度']), JSON.stringify(zh.ocrOptions))
    check('无横向溢出（540 宽）', zh.overflowX <= 0 && zh.rowOverflow.length === 0,
      'doc=' + zh.overflowX + ' rows=' + JSON.stringify(zh.rowOverflow))

    console.log('\n== 设置页：切换到 English（不刷新页面）==')
    // 走真实交互路径：改下拉 → change 事件 → setLanguage → 主进程广播
    await settingsWin.webContents.executeJavaScript(`(function(){
      const sel = document.getElementById('opt-language');
      sel.value = 'en';
      sel.dispatchEvent(new Event('change'));
    })()`)
    const switched = await waitFor(settingsWin, `document.querySelector('.header h1').textContent === 'Screen OCR Settings'`)
    check('切换后立即生效（未 reload）', switched)

    const en = await snapshot(settingsWin)
    check('窗口标题为英文', en.title === 'Settings — Screen OCR', en.title)
    check('html lang = en', en.htmlLang === 'en', en.htmlLang)
    check('保存/取消按钮', en.saveText === 'Save' && en.cancelText === 'Cancel',
      en.saveText + '/' + en.cancelText)
    check('识别精度选项为英文', JSON.stringify(en.ocrOptions) === JSON.stringify(['Fast', 'Balanced', 'Accurate']), JSON.stringify(en.ocrOptions))
    check('下拉框回填 en', en.langValue === 'en', en.langValue)
    check('整页无中文残留', !en.hasCJK, JSON.stringify(en.cjkSample))
    check('英文长文案不撑破布局', en.overflowX <= 0 && en.rowOverflow.length === 0,
      'doc=' + en.overflowX + ' rows=' + JSON.stringify(en.rowOverflow))

    console.log('\n== 设置页：切换回中文 ==')
    await settingsWin.webContents.executeJavaScript(`(function(){
      const sel = document.getElementById('opt-language');
      sel.value = 'zh';
      sel.dispatchEvent(new Event('change'));
    })()`)
    const back = await waitFor(settingsWin, `document.querySelector('.header h1').textContent === '截屏 OCR 设置'`)
    const zh2 = await snapshot(settingsWin)
    check('切回中文立即生效', back)
    check('切回后标题/按钮恢复中文', zh2.headerTitle === '截屏 OCR 设置' && zh2.saveText === '保存')

    // ===================== 结果页 =====================
    console.log('\n== 结果页：英文模式 ==')
    await settingsWin.webContents.executeJavaScript(`(function(){
      const sel = document.getElementById('opt-language');
      sel.value = 'en';
      sel.dispatchEvent(new Event('change'));
    })()`)
    await waitFor(settingsWin, `document.querySelector('.header h1').textContent === 'Screen OCR Settings'`)

    const resultWin = new BrowserWindow({
      show: false, width: 720, height: 560,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--app-lang=' + currentLang] }
    })
    await resultWin.loadFile(RESULT)
    await waitFor(resultWin, `document.getElementById('btn-copy-all').textContent === 'Copy all'`)

    const rEn = await snapshot(resultWin)
    check('结果页标题为英文', rEn.title === 'Recognition Result', rEn.title)
    check('工具栏按钮英文', rEn.copyAll === 'Copy all' && rEn.copySel === 'Copy selection',
      rEn.copyAll + '/' + rEn.copySel)
    check('分组标题按语言生成（主屏/副屏）',
      JSON.stringify(rEn.screenTitles) === JSON.stringify(['Primary screen', 'Secondary screen 1']),
      JSON.stringify(rEn.screenTitles))
    check('空结果显示英文', rEn.emptyTexts.includes('(No text recognized)'), JSON.stringify(rEn.emptyTexts))
    check('结果页无中文残留', !rEn.hasCJK, JSON.stringify(rEn.cjkSample))
    check('结果页无横向溢出（720 宽）', rEn.overflowX <= 0 && rEn.toolbarOverflow <= 0,
      'doc=' + rEn.overflowX + ' toolbar=' + rEn.toolbarOverflow)

    console.log('\n== 结果页：切换到中文（已渲染内容也重绘）==')
    await resultWin.webContents.executeJavaScript(`window.api.setLanguage('zh')`)
    const rBack = await waitFor(resultWin, `document.getElementById('btn-copy-all').textContent === '复制全文'`)
    const rZh = await snapshot(resultWin)
    check('结果页切回中文立即生效', rBack)
    check('分组标题同步变为中文',
      JSON.stringify(rZh.screenTitles) === JSON.stringify(['主屏', '副屏 1']),
      JSON.stringify(rZh.screenTitles))
    check('空状态同步变为中文', rZh.emptyTexts.includes('（未识别到文字）'), JSON.stringify(rZh.emptyTexts))

    console.log('\n' + (failed === 0 ? '[ALL PASS] 中英切换 UI 全部通过' : '[FAIL] 共 ' + failed + ' 项失败'))
    if (failed !== 0) process.exitCode = 1
  } catch (e) {
    console.error('[FAIL] 测试异常:', e && e.stack ? e.stack : e)
    process.exitCode = 1
  } finally {
    setTimeout(() => app.quit(), 300)
  }
})
