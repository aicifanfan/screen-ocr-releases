// preload：通过 contextBridge 向渲染进程暴露白名单 API
const { contextBridge, ipcRenderer, webFrame } = require('electron')

// 启动语言：主进程创建窗口时通过 --app-lang=xx 传入（additionalArguments），
// 不走同步 IPC —— sendSync 在没有监听者时会干扰渲染进程后续的页面导航。
// 兜底：未传参（如单页测试）时按默认中文。
function readLanguageArg() {
  const prefix = '--app-lang='
  try {
    const hit = process.argv.find((a) => typeof a === 'string' && a.startsWith(prefix))
    if (hit) {
      const v = hit.slice(prefix.length).trim().toLowerCase()
      if (v === 'zh' || v === 'en') return v
    }
  } catch { /* 保持默认 */ }
  return 'zh'
}
const initialLanguage = readLanguageArg()

contextBridge.exposeInMainWorld('api', {
  // —— 语言（i18n）——
  // 启动时同步取语言：避免首屏先渲染中文再切成英文（闪一下）
  initialLanguage,
  // 切换语言（'auto' | 'zh' | 'en'），主进程持久化并广播给所有窗口
  setLanguage: (language) => ipcRenderer.invoke('i18n:set', language),
  // 订阅语言变更 { lang, setting }
  onLanguageChanged: (cb) => ipcRenderer.on('i18n:changed', (_e, payload) => cb(payload)),

  // —— 遮罩选区页 ——
  // 接收主进程发来的各屏截图与虚拟桌面信息 { displays, physVirtual, myIndex }
  onScreens: (cb) => ipcRenderer.on('overlay:screens', (_e, payload) => cb(payload)),
  // 主进程广播的拖拽状态（跨屏同步渲染选区）
  onSync: (cb) => ipcRenderer.on('overlay:sync', (_e, payload) => cb(payload)),
  // 遮罩预热：复用窗口立即显示（先出遮罩，截图数据稍后推入）
  onPrepare: (cb) => ipcRenderer.on('overlay:prepare', () => cb()),
  // 拖拽开始（主进程记录起点并开始轮询全局鼠标坐标）
  dragStart: () => ipcRenderer.invoke('overlay:dragStart'),
  // 拖拽结束（主进程返回最终全局物理选区矩形）
  dragEnd: () => ipcRenderer.invoke('overlay:dragEnd'),
  // 渲染进程裁好的选区（PNG dataURL）→ OCR，返回 { texts, boxes, scores }
  captureRegion: (dataUrl) => ipcRenderer.invoke('capture:region', dataUrl),
  // 识别完成后，把结果交给主进程并打开结果窗口
  showResult: (payload) => ipcRenderer.invoke('show:result', payload),
  // 关闭遮罩（Esc）
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),

  // —— 设置页 ——
  // 打开设置窗口（从结果页/托盘入口）
  openSettings: () => ipcRenderer.invoke('settings:open'),
  // 读取当前配置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  // 保存配置（partial），返回 { ok, error } 或 { ok:true }
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  // 关闭设置窗口
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  // 设置页缩放（读取/设置缩放因子，用于「界面放大」）
  getZoomFactor: () => webFrame.getZoomFactor(),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  // 应用版本号
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  // 手动检查更新
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  // 订阅更新状态推送 { state: checking|available|downloading|downloaded|none|error, ... }
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, status) => cb(status)),

  // —— 结果页 ——
  // 结果窗口加载后拉取结果
  getResult: () => ipcRenderer.invoke('result:get'),
  // 再次截图时主进程推送的新结果
  onUpdate: (cb) => ipcRenderer.on('result:update', (_e, payload) => cb(payload)),
  // 写剪贴板
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', text),
  // 关闭结果窗口（Esc / 复制后自动关闭）
  closeResult: () => ipcRenderer.invoke('result:close')
})
