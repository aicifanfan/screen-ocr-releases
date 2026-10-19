// 轻量国际化（i18n）模块
//
// 同时供两类进程使用：
//   - 主进程：const I18n = require('../shared/i18n')
//   - 渲染进程：<script src="../shared/i18n.js"></script> → window.I18n
//
// 设计要点：
//   1. 单一词典来源，避免中英文案分散在各处导致漏译；
//   2. 缺失 key 时按「当前语言 → 中文 → key 本身」回退，保证界面永远有内容；
//   3. 占位符统一用 {name}，同一 key 在两种语言下的占位符必须一致（有单测保证）；
//   4. applyDom() 扫描 data-i18n / data-i18n-title / data-i18n-placeholder，
//      切换语言时重新扫描即可，不需要刷新页面。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory() // Node / Electron 主进程
  } else {
    root.I18n = factory() // 渲染进程
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict'

  // —— 支持的语言 ——
  const LANGS = ['zh', 'en']
  const DEFAULT_LANG = 'zh' // 兜底语言：任何无法识别的情况都回退到中文

  // —— 词典 ——
  // 约定：key 使用「模块.用途」命名；占位符 {x} 必须两种语言一致。
  const MESSAGES = {
    zh: {
      // 通用
      'app.name': '截屏 OCR',

      // 托盘
      'tray.capture': '截屏识别（{shortcut}）',
      'tray.settings': '设置…',
      'tray.quit': '退出',
      'tray.tooltip': '截屏 OCR — 按 {shortcut} 截屏识别文字',
      'common.notSet': '未设置',

      // 窗口标题
      'settings.title': '设置 — 截屏 OCR',
      'result.title': '识别结果',
      'overlay.title': '截屏选区',

      // 设置页：头部
      'settings.header.title': '截屏 OCR 设置',
      'settings.header.subtitle': '截图、识别与启动行为',
      'settings.zoom.out': '缩小（Ctrl+-）',
      'settings.zoom.in': '放大（Ctrl+=）',
      'settings.zoom.reset': '重置',
      'settings.zoom.resetTitle': '重置为 100%（Ctrl+0）',

      // 设置页：语言
      'settings.card.language': '语言',
      'settings.language.label': '界面语言',
      'settings.language.desc': '切换后立即生效，无需保存；「跟随系统」按 Windows 语言自动选择',
      'settings.language.auto': '跟随系统',
      'settings.language.zh': '中文',
      'settings.language.en': 'English',

      // 设置页：快捷键
      'settings.card.hotkey': '快捷键',
      'settings.hotkey.label': '截图识别快捷键',
      'settings.hotkey.desc': '点击右侧框，然后按下新的组合键',
      'settings.hotkey.boxTitle': '点击后按下新组合键',
      'settings.hotkey.reset': '重置',
      'settings.hotkey.resetTitle': '恢复默认',
      'settings.hotkey.recording': '请按下组合键…',

      // 设置页：通用
      'settings.card.general': '通用',
      'settings.ocr.label': '识别精度',
      'settings.ocr.desc': '均衡：速度与准确度兼顾（推荐）；高精度更准但约慢 10 倍；快速适合大段文字',
      'settings.ocr.fast': '快速',
      'settings.ocr.balanced': '均衡',
      'settings.ocr.accurate': '高精度',
      'settings.autoLaunch.label': '开机自启动',
      'settings.autoLaunch.desc': '登录 Windows 后自动在后台运行',
      'settings.captureLaunch.label': '启动时立即截屏',
      'settings.captureLaunch.desc': '默认关闭。关闭时程序启动后只在托盘待命，由快捷键 / 托盘菜单主动触发截屏',
      'settings.autoClose.label': '复制后自动关闭结果',
      'settings.autoClose.desc': '复制文字后关闭结果窗口，便于直接粘贴',
      'settings.gpu.label': 'GPU 硬件加速（实验性）',
      'settings.gpu.desc': '关闭时走兼容模式（更稳定，默认开启）；开启后框选拖拽更流畅，但个别显卡驱动可能导致启动失败（崩溃后会自动降级）',

      // 设置页：关于与更新
      'settings.card.about': '关于与更新',
      'settings.version.label': '当前版本',
      'settings.version.desc': '自动检查 GitHub Releases 上的新版本',
      'settings.version.check': '检查更新',
      'settings.autoCheck.label': '启动时自动检查更新',
      'settings.autoCheck.desc': '打开应用后在后台静默检查新版本',

      // 设置页：底部与提示
      'settings.save': '保存',
      'settings.cancel': '取消',
      'settings.saved': '已保存 ✓',
      'settings.saveFailed': '保存失败',
      'settings.saveFailedWith': '保存失败：{message}',
      'settings.needShortcut': '请先设置快捷键',
      'settings.shortcutOccupied': '该快捷键被其他程序占用，请换一个组合',

      // 更新状态
      'update.checking': '正在检查更新…',
      'update.available': '发现新版本 v{version}，开始下载…',
      'update.downloading': '正在下载更新 {percent}%',
      'update.downloaded': '新版本已下载，重启后生效',
      'update.none': '已是最新版本',
      'update.error': '更新失败：{message}',
      'update.devMode': '开发模式不支持自动更新，请安装正式版后使用',
      'update.unknownError': '未知错误',
      'update.dialogTitle': '更新就绪',
      'update.dialogMessage': '新版本已下载完成',
      'update.dialogDetail': '点击「立即重启」马上安装并重启应用；或选择「稍后」，退出时自动安装。',
      'update.restartNow': '立即重启',
      'update.later': '稍后',

      // 结果页
      'result.copyAll': '复制全文',
      'result.copySel': '复制选中',
      'result.refining': '精修中…',
      'result.showBoxes': '显示识别框',
      'result.autoClose': '复制后关闭',
      'result.autoCloseTitle': '复制后自动关闭结果窗口，便于直接粘贴到别处',
      'result.settings': '⚙ 设置',
      'result.settingsTitle': '打开设置',
      'result.copied': '已复制✓',
      'result.copiedAll': '已复制全文',
      'result.copiedSel': '已复制选中内容',
      'result.selectFirst': '请先划选文字',
      'result.selectedChars': '已选 {n} 字',
      'result.empty': '（未识别到文字）',
      'result.emptyHint': '换一块区域重新截屏，或确认截图中包含文字',
      'result.noImage': '无原图',
      'result.copy': '复制',
      'result.screenN': '屏幕 {n}',
      'result.primaryScreen': '主屏',
      'result.secondaryScreenN': '副屏 {n}',
      'result.crossScreen': '跨屏选区',
      'result.confidence': '置信度 {percent}%',
      'result.imageAlt': '截图',
      'result.selectionLabel': '选区',

      // 遮罩页
      'overlay.error': '识别失败：{message}',
      'overlay.emptySelection': '选区数据为空',
      'overlay.ocrExited': '识别服务已退出，请重试',
      'overlay.recognizing': '正在识别…',
      'overlay.timeout': '识别超时，请缩小选区后重试',
      'overlay.tooLarge': '选区过大，请缩小范围后重试',
      'overlay.captureFailed': '截图失败：{message}',

      // 主进程：设置保存错误
      'error.unknown': '未知错误'
    },

    en: {
      'app.name': 'Screen OCR',

      'tray.capture': 'Capture Text ({shortcut})',
      'tray.settings': 'Settings…',
      'tray.quit': 'Quit',
      'tray.tooltip': 'Screen OCR — press {shortcut} to capture text',
      'common.notSet': 'Not set',

      'settings.title': 'Settings — Screen OCR',
      'result.title': 'Recognition Result',
      'overlay.title': 'Screen Capture',

      'settings.header.title': 'Screen OCR Settings',
      'settings.header.subtitle': 'Capture, recognition and startup',
      'settings.zoom.out': 'Zoom out (Ctrl+-)',
      'settings.zoom.in': 'Zoom in (Ctrl+=)',
      'settings.zoom.reset': 'Reset',
      'settings.zoom.resetTitle': 'Reset to 100% (Ctrl+0)',

      'settings.card.language': 'Language',
      'settings.language.label': 'Interface language',
      'settings.language.desc': 'Takes effect immediately, no save needed. "System" follows your Windows language.',
      'settings.language.auto': 'System',
      'settings.language.zh': '中文',
      'settings.language.en': 'English',

      'settings.card.hotkey': 'Shortcut',
      'settings.hotkey.label': 'Capture shortcut',
      'settings.hotkey.desc': 'Click the box, then press a new key combination',
      'settings.hotkey.boxTitle': 'Click, then press a new combination',
      'settings.hotkey.reset': 'Reset',
      'settings.hotkey.resetTitle': 'Restore default',
      'settings.hotkey.recording': 'Press a key combination…',

      'settings.card.general': 'General',
      'settings.ocr.label': 'Recognition accuracy',
      'settings.ocr.desc': 'Balanced: good speed and accuracy (recommended). Accurate is more precise but ~10x slower. Fast suits large blocks of text.',
      'settings.ocr.fast': 'Fast',
      'settings.ocr.balanced': 'Balanced',
      'settings.ocr.accurate': 'Accurate',
      'settings.autoLaunch.label': 'Launch at login',
      'settings.autoLaunch.desc': 'Run in the background after you sign in to Windows',
      'settings.captureLaunch.label': 'Capture on launch',
      'settings.captureLaunch.desc': 'Off by default. When off, the app waits in the tray and captures only when triggered by shortcut or tray menu.',
      'settings.autoClose.label': 'Close result after copy',
      'settings.autoClose.desc': 'Close the result window after copying so you can paste right away',
      'settings.gpu.label': 'GPU acceleration (experimental)',
      'settings.gpu.desc': 'Off uses compatibility mode (more stable, default). On gives smoother dragging, but some GPU drivers may prevent startup (auto-fallback after a crash).',

      'settings.card.about': 'About & updates',
      'settings.version.label': 'Current version',
      'settings.version.desc': 'Automatically checks for new versions on GitHub Releases',
      'settings.version.check': 'Check for updates',
      'settings.autoCheck.label': 'Check for updates on launch',
      'settings.autoCheck.desc': 'Silently check for new versions in the background',

      'settings.save': 'Save',
      'settings.cancel': 'Cancel',
      'settings.saved': 'Saved ✓',
      'settings.saveFailed': 'Save failed',
      'settings.saveFailedWith': 'Save failed: {message}',
      'settings.needShortcut': 'Set a shortcut first',
      'settings.shortcutOccupied': 'That shortcut is already used by another program. Please choose another.',

      'update.checking': 'Checking for updates…',
      'update.available': 'New version v{version} found, downloading…',
      'update.downloading': 'Downloading update {percent}%',
      'update.downloaded': 'Update downloaded, restart to apply',
      'update.none': "You're on the latest version",
      'update.error': 'Update failed: {message}',
      'update.devMode': 'Auto-update is unavailable in dev mode. Please install the release build.',
      'update.unknownError': 'Unknown error',
      'update.dialogTitle': 'Update ready',
      'update.dialogMessage': 'The new version has been downloaded',
      'update.dialogDetail': 'Click "Restart now" to install and restart immediately, or "Later" to install when you quit.',
      'update.restartNow': 'Restart now',
      'update.later': 'Later',

      'result.copyAll': 'Copy all',
      'result.copySel': 'Copy selection',
      'result.refining': 'Refining…',
      'result.showBoxes': 'Show boxes',
      'result.autoClose': 'Close after copy',
      'result.autoCloseTitle': 'Close the result window after copying so you can paste elsewhere',
      'result.settings': '⚙ Settings',
      'result.settingsTitle': 'Open settings',
      'result.copied': 'Copied ✓',
      'result.copiedAll': 'Copied all',
      'result.copiedSel': 'Copied selection',
      'result.selectFirst': 'Select some text first',
      'result.selectedChars': '{n} selected',
      'result.empty': '(No text recognized)',
      'result.emptyHint': 'Capture a different area, or make sure the screenshot contains text',
      'result.noImage': 'No image',
      'result.copy': 'Copy',
      'result.screenN': 'Screen {n}',
      'result.primaryScreen': 'Primary screen',
      'result.secondaryScreenN': 'Secondary screen {n}',
      'result.crossScreen': 'Cross-screen selection',
      'result.confidence': 'Confidence {percent}%',
      'result.imageAlt': 'Screenshot',
      'result.selectionLabel': 'Selection',

      'overlay.error': 'Recognition failed: {message}',
      'overlay.emptySelection': 'Empty selection data',
      'overlay.ocrExited': 'The recognition service has stopped. Please try again.',
      'overlay.recognizing': 'Recognizing…',
      'overlay.timeout': 'Recognition timed out. Try selecting a smaller area.',
      'overlay.tooLarge': 'Selection is too large. Select a smaller area.',
      'overlay.captureFailed': 'Capture failed: {message}',

      'error.unknown': 'Unknown error'
    }
  }

  // 语言别名 → 内部标准代码
  const ALIASES = {
    zh: 'zh', 'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-sg': 'zh', chinese: 'zh', '中文': 'zh',
    en: 'en', 'en-us': 'en', 'en-gb': 'en', english: 'en', '英文': 'en'
  }

  /**
   * 把任意输入归一化为标准语言代码。
   * 无法识别时返回 fallback（默认 zh），保证永远有可用语言。
   */
  function normalizeLang(value, fallback) {
    const fb = fallback || DEFAULT_LANG
    if (!value || typeof value !== 'string') return fb
    const key = value.trim().toLowerCase().replace(/_/g, '-')
    if (ALIASES[key]) return ALIASES[key]
    // 形如 zh-Hans-CN / en-AU 的更长标签，取主语言
    const primary = key.split('-')[0]
    if (ALIASES[primary]) return ALIASES[primary]
    return fb
  }

  /**
   * 解析「设置项 + 系统语言」得到最终语言。
   * setting: 'auto' | 'zh' | 'en'；非法值一律按 auto 处理。
   * 回退顺序：显式设置 → 系统语言 → 默认语言（zh）
   */
  function resolveLang(setting, systemLang) {
    const s = normalizeSetting(setting)
    if (s === 'auto') return normalizeLang(systemLang, DEFAULT_LANG)
    return s
  }

  /** 是否为受支持的设置值（auto/zh/en），否则回落到 auto */
  function normalizeSetting(setting) {
    const s = typeof setting === 'string' ? setting.trim().toLowerCase() : 'auto'
    if (s === 'auto' || s === 'zh' || s === 'en') return s
    return 'auto'
  }

  function interpolate(text, params) {
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (m, name) => {
      const v = params[name]
      return v === undefined || v === null ? m : String(v)
    })
  }

  /**
   * 取译文。回退链：当前语言 → 中文（DEFAULT_LANG）→ key 本身。
   * 这样即使漏译也不会出现空白或报错。
   */
  function t(lang, key, params) {
    const l = normalizeLang(lang, DEFAULT_LANG)
    const table = MESSAGES[l] || {}
    let text = table[key]
    if (text === undefined) text = MESSAGES[DEFAULT_LANG][key]
    if (text === undefined) return key
    return interpolate(text, params)
  }

  /**
   * 把 DOM 里带标记的元素翻译成目标语言。
   *   data-i18n            → textContent
   *   data-i18n-title      → title 属性
   *   data-i18n-placeholder→ placeholder 属性
   * 同时同步 <html lang>，便于系统按语言选择字体/断词规则。
   */
  function applyDom(root, lang) {
    if (!root || !root.querySelectorAll) return
    const l = normalizeLang(lang, DEFAULT_LANG)
    const doc = root.ownerDocument || root
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(l, el.getAttribute('data-i18n'))
    })
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(l, el.getAttribute('data-i18n-title')))
    })
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.setAttribute('placeholder', t(l, el.getAttribute('data-i18n-placeholder')))
    })
    if (doc && doc.documentElement) {
      doc.documentElement.lang = l === 'en' ? 'en' : 'zh-CN'
    }
  }

  /** 暴露词典（只读用途：测试 / 调试） */
  function messages() { return MESSAGES }

  return { LANGS, DEFAULT_LANG, MESSAGES, normalizeLang, normalizeSetting, resolveLang, t, applyDom, messages }
})
