// 识别档位的唯一来源（前端选项、主进程校验、sidecar 参数都从这里取）。
//
// 以前「fast / balanced / accurate」这三个字符串散落在 settings.html、settings.js、
// config.js、index.js、ocr-bridge.js 里各写一遍，新增档位要改 5 处，漏一处就是
// 「切了没反应」或「静默回退」。
//
// 与快捷键处理无关：快捷键只关心 accelerator 字符串，档位只关心识别策略，两者不要互相引用。
//
// 写法与 crop-math.js 一致（UMD）：主进程 require，渲染进程用 <script> 引入后挂在 window.Profiles。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.Profiles = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // 顺序即界面下拉框顺序
  const PROFILES = [
    {
      id: 'fast',
      labelKey: 'settings.ocr.fast', // 与 i18n 词典对应
      model: { det: 'tiny', rec: 'tiny', limitSideLen: 736 },
      progressive: false
    },
    {
      id: 'balanced',
      labelKey: 'settings.ocr.balanced',
      model: { det: 'small', rec: 'small', limitSideLen: 960 },
      progressive: false
    },
    {
      id: 'accurate',
      labelKey: 'settings.ocr.accurate',
      model: { det: 'small', rec: 'small', limitSideLen: 960, refine: 'medium' },
      progressive: true
    }
  ]

  const DEFAULT_PROFILE = 'balanced'
  const PROFILE_IDS = PROFILES.map((p) => p.id)

  function isValidProfile(id) {
    return PROFILE_IDS.indexOf(String(id || '').trim().toLowerCase()) >= 0
  }

  /** 非法值统一回落到默认档（不抛错：配置可能被手改坏，不能因此起不来） */
  function normalizeProfile(id, fallback) {
    const v = String(id || '').trim().toLowerCase()
    return isValidProfile(v) ? v : (fallback || DEFAULT_PROFILE)
  }

  function getProfile(id) {
    const norm = normalizeProfile(id)
    for (const p of PROFILES) if (p.id === norm) return p
    return PROFILES[1]
  }

  return { PROFILES, PROFILE_IDS, DEFAULT_PROFILE, isValidProfile, normalizeProfile, getProfile }
})
