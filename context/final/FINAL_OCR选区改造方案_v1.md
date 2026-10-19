# OCR 文本选择界面 · 视觉美化改造方案

> 对象：`screen-ocr/src/renderer/result.html` + `result.js`（结果页文本选择界面）
> 运行环境：Electron 31.7.7 / Chromium 126（单引擎，无需考虑 Firefox/Safari 差异）
> 结论性质：按「可直接落地 / 需定制 / 不采用」分级，优先解决影响可用性的结构问题，其次才是配色与动效。

---

## 0. 结论摘要（先看这 5 条）

1. **有一个 P0 级结构缺陷，不是审美问题**：每行 OCR 文本都是独立的 `contentEditable`，Blink 会把鼠标拖选钳制在单个「编辑主机」内。实测从第 1 行拖到第 3 行，只选中第 1 行（12 字）；改成单容器后同样操作选中 38 字、3 行全中。**跨行划选复制目前是坏的**，必须先把结构改对，再谈美化。
2. **现有配色基本不用动**：选区 `#0b2b52` on `#c9dcfd` 实测 **10.22:1**，已达 WCAG AAA。真正要修的是 `.empty` 的 `#94a3b8`（**2.56:1**，AA 不合格）。
3. **视觉层级要收敛成一条「淡到浓」的阶梯**：唯一实色高亮只留给「文本选区」，联动指向用「极淡底 + 左侧色条」，识别框用「描边 + 低透明填充」。现在 5 层蓝色（.06/.14/.16/#eff6ff/#c9dcfd）彼此太近，用户分不清「我选的」和「系统指的」。
4. **GitHub 上能直接抄的很少**：文本高亮类库（mark.js / web-highlighter）靠拆分、包裹文本节点实现，与 `contentEditable` 的编辑与选区映射天然冲突，**不能用在可编辑结果页**。真正值得借鉴的是「令牌体系 + 浮层定位」两类，且都不需要引包。
5. **不建议做**：自绘移动端选择手柄、引入 auto-animate / OverlayScrollbars / tippy（已归档）、深色主题。收益低、回归面大。

---

## 1. 现状盘点（代码级）

### 1.1 已经做对、应当保留的部分

| 项 | 位置 | 评价 |
|---|---|---|
| 设计令牌集中管理 | `result.html:14-40` | 语义清晰，已有 `--sel-bg/--sel-text` 独立命名 |
| 三态分层思路（选区/联动/识别框） | `result.html:9-12` 注释 | 方向正确，只需调数值 |
| 选区对比度 | `#0b2b52` / `#c9dcfd` | 10.22:1，保留 |
| `selectionchange` 用 rAF 节流 | `result.js:63-71` | 拖选时不掉帧的关键，保留 |
| 触摸端去掉 hover | `result.html:267-270` | 正确处理了「hover 粘住」 |
| `prefers-reduced-motion` | `result.html:273-275` | 保留 |
| 窄屏 36px 触摸目标 + 上下堆叠 | `result.html:250-264` | 保留 |
| 已有视觉回归测试 | `test_result_ui.js` | 改样式后必须跑通 |

### 1.2 问题清单（按优先级）

| 级别 | 问题 | 证据 / 位置 | 影响 |
|---|---|---|---|
| **P0** | 跨行拖选被编辑主机截断 | 实测：3 行只选中 1 行；`result.js:164-175` 每行单独 `contentEditable` | 核心功能不可用 |
| **P1** | 拖拽过程中 `:hover` 背景逐行跟随 | `result.html:213` + `:hover` 无拖拽态抑制 | 视觉抖动，像"高亮在追鼠标" |
| **P1** | 空状态文字对比度不足 | `.empty` 用 `--text-dim：#94a3b8`，**2.56:1** | 13px 小字读不清 |
| **P1** | 标题/图片区可被拖选进选区 | `.screen-title`、`.img-panel` 未设 `user-select:none` | 从下往上拖会选进屏名 |
| **P2** | 复制反馈使按钮宽度跳变 | `result.js:73-78` 直接换 `textContent` | 整条工具栏横向抖动 |
| **P2** | 计数胶囊宽度变化推挤设置按钮 | `#status` 无 `min-width` | 拖选时右侧元素左右晃 |
| **P2** | 识别框默认 6% 填充压住原图 | `result.html:182-189` | 对照原图时发灰 |
| **P2** | `.done` 整块绿色填充 | `result.html:94-97` | 蓝色界面里突然闪绿，视觉权重过高 |
| **P3** | `word-break: break-word` 已废弃 | `result.html:208` | 建议换 `overflow-wrap: anywhere` |

---

## 2. GitHub 资源调研

> 规模数据取自 GitHub API（2026-10-19）。判定标准：能否在不破坏 `contentEditable` 选区与编辑的前提下，直接改善本项目。

| 项目 | 规模 / 活跃度 | 用途 | 适用场景 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|---|---|
| **CSS Custom Highlight API**（W3C / MDN） | Baseline 2026-03；Chrome 105+ | 不改 DOM 给任意 Range 上色 | 搜索命中、持久标注、多段高亮 | 零 DOM 侵入，与可编辑区共存，性能好 | 只支持 `color/background/text-decoration/text-shadow`，做不了边框圆角 | **暂不引入**（当前无多段高亮需求） |
| **floating-ui/floating-ui** | 32.8k / MIT / 2026-10 活跃 | 浮层定位（翻转、避让边界） | 选中即弹的小工具条 | 碰撞检测成熟，`getBoundingClientRect` 的坑都替你填了 | 项目无打包器（纯 `<script>`），为 1 个气泡引依赖不划算 | **需定制 / 可选**：单气泡手写约 40 行即可 |
| **radix-ui/colors** | 1.7k / MIT / 2025-12 | 12 阶语义色板 | 建立 tint 阶梯 | 每一阶用途有明确定义，直接解决"5 层蓝分不清" | 整套 token 与现有 6 个变量冲突 | **只借思路**：按 3/8/11 阶取值，不引包 |
| **argyleink/open-props** | 5.5k / MIT / 2026-10 活跃 | CSS 变量（easing/shadow/radius） | 统一动效曲线与阴影 | 零运行时，可单文件引 | 全量体积大、命名体系侵入强 | **只抄值**：`--ease-*`、`--shadow-*` |
| **alienzhou/web-highlighter** | 988 / MIT / 2026-10 活跃 | 网页文本高亮 + 持久化 | 阅读批注 | 无依赖，Range 转高亮，可序列化 | **拆分并替换文本节点**，与 `contentEditable` 编辑冲突；跨表格单元格不支持 | **不采用**（做批注功能时再评估） |
| **julkue/mark.js** | 2.6k / MIT / dist 停在 2018 | 关键词高亮 | 静态页面搜词 | API 简单 | DOM 包裹、jQuery 时代产物、实质停更 | **不采用** |
| **daybrush/selecto** | 2.2k / MIT / 2024-06 后停更，94 open issues | 鼠标/触摸拖框选元素 | 框选多张卡片 | 支持触摸、命中率可调 | 选的是元素不是文本；与原生文本选区互斥 | **不适用** |
| **ThibaultJanBeyer/DragSelect** | 768 / 自定义许可 | 拖拽选择元素 | 列表多选 | 无依赖、有拖拽自动滚动 | 同上，且许可为 NOASSERTION | **不适用** |
| **KingSora/OverlayScrollbars** | 5.2k / MIT / 2026-10 活跃 | 跨平台自绘滚动条 | 需要滚动条完全一致 | 样式统一、原生手感 | 需 JS 初始化，与拖选自动滚动存在交互边界 | **不需要**：现有 `::-webkit-scrollbar` 足够 |
| **formkit/auto-animate** | 13.9k / MIT / 2026-07 | 列表增删 FLIP 动画 | 动态列表 | 一行接入 | 当前是 `innerHTML` 全量重建，接入需改渲染；连续截图刷新时动画反而拖慢 | **不采用** |
| **atomiks/tippyjs** | 12.2k / **已归档（archived）** | 气泡、菜单 | 浮层交互 | 生态成熟 | 2024 年后停止维护 | **不推荐**（列此避免踩坑） |
| **timdown/rangy** | 2.3k / MIT / 176 open issues | 跨浏览器 Range 兼容层 | 老浏览器 | 兼容 IE 时代 API | Blink 单引擎下纯属冗余 | **不采用** |
| **mobile-text-selection** | 上游约 10 star / ISC / 2023 后停更 | 移动端长按自绘手柄 + 放大镜 | H5 阅读器 | 唯一现成的"自绘手柄"参考 | 接管原生选区，丢失系统复制、输入法、无障碍；容器滚动有已知问题 | **不采用**：保留系统手柄 |

### 调研结论

- **没有可以直接安装使用的"文本选择美化组件"**。这类效果在 Chromium 下几乎全部由 `::selection` + 容器结构 + 状态类三件事决定，库帮不上忙，反而会和 `contentEditable` 打架。
- 真正可复用的只有两类：**色彩阶梯方法**（Radix 的 12 阶思路）和**浮层定位算法**（floating-ui 的 flip/shift 思路）。
- 因此本方案以「手写 CSS + 少量 JS」为主，**零新增依赖**，这也符合当前无打包器的工程形态。

---

## 3. 视觉体系：一条阶梯，而不是五种蓝

### 3.1 核心原则

> **全界面只有「文本选区」可以使用实色底；其余所有状态一律用描边、色条或 ≤12% 的淡底表达。**

理由：选区是用户主动操作产生的结果，必须是视觉最强的一层；联动指向是被动反馈，抢戏就会让用户以为"这段已经被选中了"。

### 3.2 令牌阶梯（可直接替换 `result.html:25-34`）

| 层级 | 语义 | 值 | 与白底对比 | 说明 |
|---|---|---|---|---|
| L0 | 画布 | `#ffffff` | — | 不动 |
| L1 | 分区底（图区、屏名） | `#f8fafc` | 1.02 | 不动 |
| L2 | 指针悬停 | `#f4f7fb` | 1.06 | 仅 `hover:hover` 生效 |
| L3 | 联动指向 | `#eff6ff` + 2px 左侧主色条 | 1.09 | 靠色条传达，不靠底色 |
| L4 | 识别框激活 | `rgba(37,99,235,.12)` + 2px 描边 | — | 覆盖在图片上，必须让图透出来 |
| L5 | 文本选中 | `#c9dcfd` + `#0b2b52` | 1.39 / **10.22:1** | 唯一实色层，保留现值 |

```css
:root {
  /* 阶梯：0 画布 → 1 分区 → 2 悬停 → 3 联动 → 4 框选 → 5 文本选中 */
  --tint-hover:  #f4f7fb;   /* L2 */
  --tint-link:   #eff6ff;   /* L3 */
  --tint-box:    rgba(37, 99, 235, .12);  /* L4 */
  --sel-bg:      #c9dcfd;   /* L5，保持字面 hex：测试用例按 hex 解析 */
  --sel-text:    #0b2b52;

  --bar-link: 2px;          /* 联动色条宽度，全站统一 */
  --ease-out: cubic-bezier(.2, .8, .2, 1);  /* 借鉴 open-props 的 ease-out */
}
```

> 注意：**不要把 `--sel-bg` 改成 `color-mix(...)`**。`test_result_ui.js:70` 用 `parseInt(hex.slice())` 解析变量值，改成函数式颜色会让测试直接崩。

### 3.3 状态矩阵（改造后）

| 状态 | 文字块 | 识别框 | 触发 |
|---|---|---|---|
| 未选中 | 无背景 | 1px `rgba(37,99,235,.38)`，**无填充** | 默认 |
| 悬停 | `--tint-hover` 整行 | 填充 `.08` | 指针设备 |
| 联动指向 | `--tint-link` + 左 2px 主色条 | 2px 描边 + `.12` 填充 + 外发光 | 点击任一区域 |
| 拖拽中 | **抑制 hover**，只有选区 | 不变 | 按下鼠标 → 松开 |
| 文本选中 | `--sel-bg` + `--sel-text` | — | 原生选区 |

---

## 4. 改造要点（可直接照做）

### P0-1 把「多编辑主机」合并为「单一编辑容器」

**问题**：`result.js:164-175` 为每行创建 `contentEditable`。Blink 的选区在编辑态下被约束在单个 *root editable element* 内，跨行拖选在第二行边界就断了。

**实测证据**（Electron 31.7.7，真实 `sendInputEvent` 拖拽）：

| 结构 | 拖选结果 | 跨主机 |
|---|---|---|
| 3 个独立 `contentEditable` | `"一行识别文字 ABC 123"`（12 字，仅第 1 行） | 否 |
| 1 个 `contentEditable` + 3 个块级子节点 | 3 行全部选中（38 字，含 `\n`） | — |

**改法**：文字面板只保留一个可编辑根，行作为它的块级子节点（`.item` 不再设 `contentEditable`）。

```js
// result.js —— 替换 renderScreen 中的 textPanel 构建段
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

textPanel.appendChild(editor)   // 空状态仍用 .empty，插在 editor 之后
```

**编辑同步**：行数必须与 `items` 一一对应，否则复制全文会错位。

```js
// 行数 = 识别框数的约定，靠这两条守住
editor.addEventListener('input', () => {
  editor.querySelectorAll(':scope > .item').forEach((el, i) => {
    if (s.items[i]) s.items[i].text = el.textContent
  })
})

editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()   // 禁止拆行：1 行 = 1 个识别框，拆了就映射不上
    document.execCommand('insertLineBreak') // 可选：允许行内换行但不新增块
  }
})

editor.addEventListener('paste', (e) => {
  e.preventDefault()
  const raw = e.clipboardData ? e.clipboardData.getData('text/plain') : ''
  // 多行粘贴压平成单行，保持行数不变
  document.execCommand('insertText', false, raw.replace(/\s*\n\s*/g, ' '))
})
```

**兼容性**：`.item` 元素仍然存在，`test_result_ui.js` 里对 `.item` 的查询（第 148 行）不受影响；`getSelection().toString()` 在块级子节点之间会输出 `\n`，`复制选中` 的换行表现反而更正确。

**边界**：跨「屏分组」的选区仍会被截断（每组一个编辑根）。这是可接受的产品边界——跨屏复制走「复制全文」，不要为此把整个页面做成一个编辑根。

---

### P0-2 配套 CSS：让编辑根不引入新视觉

```css
.editor {
  outline: none;            /* 编辑根本身不要焦点框 */
  min-height: 100%;
}
/* .item 已不需要 contentEditable，去掉 focus-visible 规则 */
.item {
  padding: 0 8px;
  line-height: 1.7;         /* 保持；不要用纵向 margin 代替，会切断选区 */
  overflow-wrap: anywhere;  /* 替代已废弃的 word-break: break-word */
  white-space: pre-wrap;
  cursor: text;
}
```

---

### P1-1 拖拽期间抑制 hover（消除"高亮追鼠标"）

**问题**：拖选时鼠标扫过每一行都会触发 `.item:hover`，背景在 `#f4f7fb` 与选区色之间反复切换。

```js
// 全局只需一份：按下标脏，松开清脏
let selecting = false
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  selecting = true
  document.body.classList.add('is-selecting')
})
const endSelect = () => {
  if (!selecting) return
  selecting = false
  document.body.classList.remove('is-selecting')
}
document.addEventListener('pointerup', endSelect)
document.addEventListener('pointercancel', endSelect)
```

```css
body.is-selecting .item:hover:not(.active) { background: transparent; }
body.is-selecting .box:hover:not(.active)  { background: transparent;
  border-color: rgba(37, 99, 235, .38); }
```

> 不要用 `pointerdown` 绑在 `.item` 上——拖到面板外松开时会漏掉 `pointerup`，必须绑在 `document`。

---

### P1-2 非文本区域禁止进入选区

从文字区往上拖时，屏名、工具栏文案、图片 `alt` 都可能被选进去，复制出来是脏数据。

```css
.toolbar,
.screen-title,
.img-panel,
.empty { user-select: none; }

.text-panel { overscroll-behavior: contain; } /* 滚到底不把滚动传给外层 */
```

---

### P1-3 可读性修正

```css
/* 原：--text-dim: #94a3b8 → 2.56:1，13px 不合格 */
.empty { color: var(--text-muted); }   /* #64748b → 4.76:1 */
```

其余保持：正文 `#1f2937` on `#fff` 为 **14.68:1**，`--text-muted` on `#f8fafc` 为 **4.55:1**，均已达标。

---

### P2-1 复制反馈不再撑动工具栏

**问题**：`result.js:73-78` 把「复制全文」换成「已复制」，字数变化导致宽度收缩，整条工具栏重排。

```js
function buttonFeedback(btn, text) {
  // 首次点击时锁定当前宽度，后续文案变化不再引起 reflow
  if (!btn.dataset.minW) {
    btn.style.minWidth = btn.offsetWidth + 'px'
    btn.dataset.minW = '1'
  }
  const orig = btn.textContent
  btn.textContent = text
  btn.classList.add('done')
  setTimeout(() => { btn.textContent = orig; btn.classList.remove('done') }, 1200)
}
```

**同时把成功态从"整块绿"降级**，避免蓝色界面里突然跳出一块高饱和绿：

```css
.toolbar button.done {
  background: #ecfdf5;          /* 浅底 */
  color: var(--ok);             /* #15803d on #ecfdf5 = 4.76:1 */
  border-color: #86efac;
  box-shadow: none;
}
```

**计数胶囊固定宽度**，避免拖选时数字从 9→10 推挤右侧按钮：

```css
#status:not(:empty) {
  min-width: 7em;
  justify-content: center;
  font-variant-numeric: tabular-nums;  /* 已有 */
}
```

---

### P2-2 识别框「静默化」

原图是用户要读的内容，默认 6% 蓝填充会让截图整体发灰。改为「默认只描边，交互才上色」：

```css
.box {
  border: 1px solid rgba(37, 99, 235, .38);
  background: transparent;       /* 原 .06 去掉 */
}
.box:hover  { background: rgba(37, 99, 235, .08); border-color: var(--primary); }
.box.active {
  border: 2px solid var(--primary-hover);
  background: rgba(37, 99, 235, .12);
  box-shadow: 0 0 0 2px var(--primary-ring);
}
```

`box-sizing: border-box` 已全局生效，1px→2px 不会引起框体位移。

---

### P2-3 选区浮条（可选，做不做都行）

**收益**：选完文字后，「复制」按钮在顶部工具栏，鼠标要跑一趟；浮条把动作放在指尖。
**成本**：约 40 行，零依赖。**但它是锦上添花——如果只改一件事，先改 P0。**

```js
const pill = document.createElement('div')
pill.className = 'sel-pill'
pill.hidden = true
pill.innerHTML = '<button data-act="copy">复制</button>'
document.body.appendChild(pill)

document.addEventListener('mouseup', () => {
  requestAnimationFrame(() => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || !mainEl.contains(s.anchorNode)) { pill.hidden = true; return }
    const r = s.getRangeAt(0).getBoundingClientRect()
    pill.hidden = false
    const w = pill.offsetWidth, h = pill.offsetHeight
    let left = r.left + r.width / 2 - w / 2
    let top = r.bottom + 8
    if (top + h > innerHeight - 8) top = r.top - h - 8      // 下方放不下就翻到上方
    left = Math.max(8, Math.min(left, innerWidth - w - 8))  // 左右夹紧
    pill.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  })
})
// 选区塌陷 / 滚动 / 再次按下时收起
document.addEventListener('selectionchange', () => {
  const s = window.getSelection()
  if (!s || s.isCollapsed) pill.hidden = true
})
mainEl.addEventListener('scroll', () => { pill.hidden = true }, true)
```

```css
.sel-pill {
  position: fixed; left: 0; top: 0; z-index: 20;
  display: flex; padding: 3px; border-radius: 8px;
  background: #0f172a; box-shadow: 0 6px 20px rgba(15, 23, 42, .28);
  animation: pill-in .12s var(--ease-out);
}
.sel-pill button {
  height: 26px; padding: 0 10px; border: 0; border-radius: 6px;
  background: transparent; color: #fff; font: inherit; font-size: 12.5px; cursor: pointer;
}
.sel-pill button:hover { background: rgba(255, 255, 255, .14); }
@keyframes pill-in { from { opacity: 0; transform-origin: top center; } }
```

> 这里是 `floating-ui` 那套逻辑的最小实现（翻转 + 夹紧）。只有当浮条要承载多个动作、或需要在滚动容器内持续跟随，才值得换成 `@floating-ui/dom`。

---

## 5. 桌面 / 移动适配

Electron 桌面端没有系统的文本选择手柄，触屏 Windows 设备由 Chromium 绘制原生手柄——**不要自绘**，否则会丢掉系统复制、输入法和无障碍。

```css
/* 窄屏：分栏改堆叠后，图区限高，避免把文字挤出首屏 */
@media (max-width: 760px) {
  .img-panel { max-height: 42vh; }
  .text-panel { max-height: none; }
  .item { padding: 0 12px; line-height: 1.75; }  /* 窄屏行距略松，缓解密集 OCR 文本 */
}

/* 触摸/笔：加大点击目标，hover 已在 (hover:none) 中关闭 */
@media (pointer: coarse) {
  .toolbar button { height: 40px; }
  .item { padding-top: 2px; padding-bottom: 2px; }  /* 增大纵向命中区，不影响选区连续 */
}
```

- 不要把 `.item` 的间距改成 `margin` —— 纵向 margin 会让跨行选区出现白色断带，只能用 `line-height` 和 `padding` 调。
- 窄屏下 `.screen-body` 堆叠后，文字与图片的联动意义减弱；保持 42vh 限高即可，不必做双向滚动同步。

---

## 6. 明确不建议做的事

| 想法 | 为什么不做 |
|---|---|
| 自绘移动端选择手柄（放大镜、拖拽圆点） | 需接管原生选区，丢系统复制/输入法/无障碍；桌面端根本用不上 |
| 引入 mark.js / web-highlighter 做高亮 | 都会拆分包裹文本节点，直接在可编辑区制造 DOM 与映射错乱 |
| 用 CSS Custom Highlight API 重做联动高亮 | 它只能改颜色/下划线，做不了圆角、外发光、定位色条；现有 class 方案更合适 |
| 引入 auto-animate 做刷新动画 | 连续截图会频繁重绘，动画只会拖慢首屏；`prefers-reduced-motion` 用户还要关掉 |
| 加 OverlayScrollbars | 现有 3 条 `::-webkit-scrollbar` 规则已跨平台一致，引入 JS 滚动条反而与拖选自动滚动冲突 |
| 深色主题 | 工作量是改一遍全部令牌 + 重新验对比度，与本次「选区可读性」目标无关，单列需求再做 |
| 给每行加圆角卡片 / 阴影 | OCR 文本是连续段落，卡片化会切断跨行选区，且增加视觉噪音 |

---

## 7. 验收清单（建议补进 `test_result_ui.js`）

结构类（防回归，比模拟鼠标稳）：

```js
// 每个文字面板只能有 1 个 contentEditable 根
const hosts = await win.webContents.executeJavaScript(
  `document.querySelectorAll('.text-panel [contenteditable="true"]').length`)
check('每个文字面板仅 1 个编辑根', hosts === 1, hosts + ' 个')

// 行节点仍是 .item，保证既有选择器与测试不失效
const lines = await win.webContents.executeJavaScript(
  `document.querySelectorAll('.editor > .item').length`)
check('行节点结构保持', lines > 0, lines + ' 行')
```

视觉/交互类：

- [ ] `.empty` 对比度 ≥ 4.5:1（现为 2.56）
- [ ] 拖拽中 `.item:hover` 不生效（`body.is-selecting` 存在时背景为 `rgba(0,0,0,0)`）
- [ ] `.toolbar` / `.img-panel` 的 `user-select` 为 `none`
- [ ] 点击复制后按钮宽度变化 ≤ 1px
- [ ] `#status` 从 9 字变 10 字时，设置按钮 `getBoundingClientRect().left` 不变
- [ ] 仍满足既有 9 项：选区对比度、三态可区分、窄屏堆叠、36px 触摸目标、无横向溢出

---

## 8. 落地顺序与风险

| 阶段 | 内容 | 改动面 | 回归风险 |
|---|---|---|---|
| 1 | P0 单容器重构 + 编辑同步 | `result.js` 约 30 行、`result.html` 约 10 行 | **高**：编辑、复制全文、多屏分组都要回归 |
| 2 | P1 拖拽态 / 不可选区 / 对比度 | `result.html` 约 15 行、`result.js` 约 12 行 | 低 |
| 3 | P2 反馈与识别框微调 | `result.html` 约 25 行、`result.js` 约 5 行 | 低 |
| 4 | 浮条（可选） | 新增约 45 行 | 中：需处理滚动/塌陷/窄屏遮挡 |

**回滚策略**：阶段 1 单独提交，改前 `git tag ui-before-refactor`；若编辑同步出现行错位，先回退到多主机版本，再只保留 P1/P2 的纯 CSS 改动（这些不依赖结构）。

**最容易踩的坑**：
1. 忘了阻止 `Enter`，用户一回车就多出一行，`getAllText()` 与识别框数量错位。
2. 把 `user-select:none` 加到 `.text-panel` 上——整块文字都无法选择。只能加到工具栏/标题/图区。
3. 用 `mousedown` 而不是 `pointerdown` 做拖拽态，触摸笔设备失效。
4. 把 `.item` 的 `padding-top` 从 0 改掉（`test_result_ui.js:150` 会直接失败，且跨行选区会出现断带）。
