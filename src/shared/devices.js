// 推理设备选项（与识别档位解耦：档位管"用哪个模型"，设备管"在哪跑"）。
//
// 值直接映射到 sidecar 的 SCREEN_OCR_DEVICE 环境变量：
//   auto → 有 GPU 就用（Windows 优先 DirectML），失败由 sidecar 回落 CPU
//   cpu  → 强制 CPU（省电、远程桌面/虚拟机排障时用）
//   dml / cuda → 仅用于开发与 A/B 测试，界面不暴露
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.Devices = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // 界面只给前两个；后两个留给环境变量/命令行
  const UI_DEVICES = [
    { id: 'auto', labelKey: 'settings.device.auto' },
    { id: 'cpu', labelKey: 'settings.device.cpu' }
  ]
  const DEVICES = ['auto', 'cpu', 'dml', 'cuda']
  const DEFAULT_DEVICE = 'auto'

  function isValidDevice(v) {
    return DEVICES.indexOf(String(v || '').trim().toLowerCase()) >= 0
  }

  /** 非法值回落 auto（手改配置不该让程序起不来） */
  function normalizeDevice(v, fallback) {
    const d = String(v || '').trim().toLowerCase()
    return isValidDevice(d) ? d : (fallback || DEFAULT_DEVICE)
  }

  return { DEVICES, UI_DEVICES, DEFAULT_DEVICE, isValidDevice, normalizeDevice }
})
