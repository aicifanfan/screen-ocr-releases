---
project: screen-ocr（截屏 OCR 工具 · Windows）
scope: 结果页「文本选择界面」视觉与交互改造 + 设置页样式体系对齐
env: Electron 31.7.7 / Chromium 126 / Windows 10-11 / 无打包器（<script>/<link> 直引）
date: 2026-10-19
version: 0.2.1（已打包）
status: 0.2.1 已打包并发布 GitHub Release（自动更新链路已通）；39 项 + i18n + 设置页回归全 PASS
next: 可选：代码签名（消除 SmartScreen 提示）
derived_from: process/2026-10-19_process.log.md
---

# 精简上下文 · OCR 文本选择界面改造

> 读这一份即可接手。需要证据原文时，按每条末尾的来源编号跳到 §7 与过程记录。
> 编号规则：`K` 结论 / `D` 决策 / `T` 待办 / `C` 约束 / `F` 产物 / `S` 来源 / `E` 实验 / `R` 调研。

## §0 一句话状态

**设计稿已完整落地**：样式拆为 tokens/base/components/page 四层，结果页具备悬停/联动/选中/拖拽/禁用/加载/空状态/无原图八种状态与选区浮条，
设置页接入同一套令牌与组件；`tests/test_result_ui.js` **39 项**、`tests/test_i18n_ui.js`、`tests/test_settings.js`、i18n 静态扫描全 PASS。

## §1 关键结论

| ID | 结论 | 证据 | 来源 |
|---|---|---|---|
| **K1** | 曾因「逐行独立 `contentEditable`」导致**跨行拖选失效**（3 行只选中 12 字）；**已修复**为单编辑根，实测 3 行 / 38 字 / 含 `\n` | 真实指针序列对照实验 | `E1`、`P-02`、`P-09` |
| **K2** | 修复方式 = **1 个编辑根 + 行级块子节点**；同操作可选中 3 行（38 字，含 `\n`） | 同上 B 组 | `E1` |
| **K3** | 选区配色**已达标**（`#0b2b52` on `#c9dcfd` = 10.22:1），不要改；空状态 `#94a3b8`（2.56:1）已改为 `#64748b`（4.76:1） | WCAG 实算 | `P-04`、`S1:30,224` |
| **K4** | 没有任何现成库能直接解决此问题；方案**零新增依赖** | 13 个仓库逐项判定 | `R1` |
| **K5** | 视觉层级原则：**全界面只有文本选区可用实色底**，其余用描边 / 色条 / ≤12% 淡底 | 现状 5 层蓝色互相抢戏 | `P-04`、`S1:181-196` |
| **K6** | 样式可安全外链到 `styles/`：file:// 下同源 CSS 的 `cssRules` 可读，`::selection` 渲染与外链/内联无关（像素级一致） | 两轮探针 | `P-11` |
| **K7** | 隐藏窗口（`show:false`）会暂停 rAF、延迟 `setContentSize` 传播；**产品侧真实存在「窗口被遮挡时选区计数不更新」**，已加 120ms 兜底 | 对照组实测 | `P-11` |

## §2 决策（含被否方案）

| ID | 决策 | 理由 | 被否 / 替代 | 来源 |
|---|---|---|---|---|
| **D1** | 文字面板改为单编辑容器 `.editor[contenteditable] > .item*` | 唯一能让原生跨行拖选生效的结构 | ①保持多编辑主机（等于放弃跨行选）②默认只读、双击才进单行编辑（交互成本更高） | `K1/K2` |
| **D2** | 守住「1 行 = 1 识别框」不变量：`Enter` 必须 `preventDefault`，粘贴把换行压平 | `getAllText()` 依赖 `items` 顺序，行数错位会串行 | 允许自由编辑、复制时按 DOM 重建 items（改动面更大） | `S2:292-299` |
| **D3** | 不引入 mark.js / web-highlighter 等高亮库 | 二者均拆分包裹文本节点，破坏编辑与选区映射 | — | `R1` |
| **D4** | `--sel-bg` 保持字面 hex，不改 `color-mix()` | `tests/test_result_ui.js` 用 `parseInt(hex)` 解析变量值，函数式颜色会让测试崩 | 用 `color-mix` 让选区色跟随主色 | `S3:70` |
| **D5** | 空状态文字 `#94a3b8` → `#64748b` | 2.56:1 → 4.76:1，13px 小字必须过 AA | — | `K3` |
| **D6** | 拖拽态用 `body.is-selecting`，`pointerdown` 绑 `document` | 绑 `.item` 会在拖到面板外松开时漏掉 `pointerup` | 用 `mousedown`（触摸笔设备失效） | `P-04` |
| **D7** | 识别框默认去掉 6% 填充，只留描边 | 半透明蓝会压住原图，对照阅读发灰 | 保留填充、提高描边对比 | `S1:181-189` |
| **D8** | 选区浮条「可选」，若做则手写约 40 行 | 项目无打包器，为 1 个气泡引 floating-ui 不划算 | 引入 `@floating-ui/dom` | `R1` |
| **D9** | 样式拆四层：`tokens`（令牌）/ `base`（reset+选区+滚动条）/ `components`（按钮/胶囊/卡片/开关/空状态/骨架/浮条）/ 页面样式 | 组件复用 + 命名规范；外链不影响 CSSOM 测试（K6） | 继续把全部样式塞进各 HTML 的 `<style>` | `K6`、`P-11` |
| **D10** | 加载态用**两栏骨架**而非 spinner | 结构与真实内容同形，数据到达不跳布局；spinner 会闪一下 | 居中转圈 / 纯文本"加载中" | `P-11` |
| **D11** | 空状态加图标与提示，但 `.empty` 的 `textContent` 保持**精确等于**原文案 | `tests/test_i18n_ui.js` 用精确值断言空状态文案 | 把提示写进 `.empty` | `S3`、`P-11` |
| **D12** | 浮条默认贴选区**下方**，放不下才翻上方，并夹在内容区内 | 盖住"接下来要读的行"比盖住已选中的行影响小；不遮工具栏 | 固定上方（会压住选中行或工具栏） | `P-11` |

## §3 未完成事项（按优先级）

| ID | 事项 | 状态 | 前置 | 改动面 | 验收 |
|---|---|---|---|---|---|
| **T1** | **P0** 单容器重构 + 编辑同步（Enter/粘贴约束） | **已完成（P-09）** | 无 | `result.js` ≈45 行、`result.html` ≈6 行 | 真实拖选可跨 3 行；回归全 PASS |
| **T2** | **P1** 拖拽态抑制 hover / 非文本区 `user-select:none` / `.empty` 对比度 | **已完成** | T1 | `result.html`、`result.js` | 拖拽中无 hover 底色；空状态 ≥4.5:1 |
| **T3** | **P2** 复制反馈锁宽 + 软成功态 / 识别框去填充 / `#status` 最小宽 | **已完成** | T1（实际未阻塞） | `result.html` + `result.js` | 复制后宽度变化 ≤1px；右侧按钮不位移 |
| **T4** | 补测试：单编辑根数量、行节点结构、`user-select`、按钮宽度稳定 | **已完成 4/4**（P-11 补上宽度与状态断言，25→39 项） | T1–T3 | `tests/test_result_ui.js` | 新增断言全 PASS |
| **T5** | 选区浮条 | **已完成（P-11）** | T1 | `result.js` ≈70 行 + `components.css` | 不遮工具栏、边界翻转、滚动/塌陷即收 |
| **T6** | 响应式：窗口变窄后图片重算缩放 | **已完成**（ResizeObserver） | — | `result.js` ≈12 行 | 各宽度无横向溢出、识别框不错位 |
| **T7** | 加载 / 空状态 / 无原图 / 禁用等边界态 | **已完成（P-11）** | T1 | `result.js` ≈90 行、`components.css` | 骨架→内容无跳动；`aria-busy` 复位 |
| **T8** | 设置页接入同一令牌与组件层 | **已完成（P-11）** | D9 | `settings.html` + `settings.css` | 540/440 宽无横向溢出；中英不破版 |
| **T9** | 打包发布 0.2.1 | **已完成（P-12/P-13）** | T1–T8 | `package.json`、`electron-builder.yml`、`dist/`、GitHub Release | 源码 `e213880` 已推；资产 3 个上传；latest → v0.2.1 |

> 风险最高的是 T1：编辑、复制全文、多屏分组、连续截图刷新都要回归。建议单独提交 + 打 tag。

## §4 约束与契约（改代码前必须知道）

| ID | 约束 |
|---|---|
| **C1** | Electron 31.7.7 → Chromium 126。`color-mix`、`::highlight`、`:has` 均可用；但 D4 限制选区色写法。 |
| **C2** | 无打包器，纯 `<script>` 引入。新增 npm 依赖需要连带改构建，成本高于手写。 |
| **C3** | DOM 契约：`.text-panel > .editor[contenteditable] > .item*`；`.item` / `.box` 选择器被联动与测试依赖，必须保留。`.item` 自身不再声明 contentEditable，编辑能力由父级继承（不要再改回逐行编辑）。 |
| **C4** | `tests/test_result_ui.js` 现有断言是红线，尤其 `::selection` 已声明、`.item` `padding-top=0`（`S3:150`）、`.empty` 文案精确匹配。 |
| **C5** | 复制全文 = `screens[].items[].text` 按数组顺序 join（`S2:292-299`）；任何改变行数的编辑都会污染结果。 |
| **C6** | 单引擎项目，不必为 Firefox/Safari 做兼容取舍（`::highlight` 的 Firefox 149 支持与否不影响本项目）。 |
| **C7** | 样式分层不改变既有选择器名（`.toolbar/.item/.box/.editor/.text-panel/.img-panel/.empty/#status` 全保留）；新组件用扁平 kebab（`.btn-ghost`），状态用 `is-*`（`.is-count/.is-selecting/.is-done/.is-loading`）。 |
| **C8** | 页面通过 `<link>` 引 `styles/*.css`，**不要再复制一份内联样式**；`npm run demo:html` 会自动把 link 内联进 `docs/result-demo.html`。 |
| **C9** | 测试里的窗口尺寸断言必须**轮询等待**媒体查询生效（`waitFor`），不能用固定 `sleep`：隐藏窗口下 resize 传播是异步的。 |

## §5 产物索引

| ID | 路径 | 体积 | 状态 |
|---|---|---:|---|
| **F1** | `docs/OCR文本选择界面-美化改造方案.md` | 23,339 B | 工作副本，末尾追加 §9 落地对照 |
| **F2** | `docs/selection-ui-preview.html` | 16,038 B | 静态设计预览（设计侧产物） |
| **F3** | `context/final/FINAL_OCR选区改造方案_v1.md` | 23,339 B | **冻结**，哈希见 MANIFEST |
| **F4** | `context/final/FINAL_selection-ui-preview_v1.html` | 16,038 B | **冻结** |
| **F5** | `context/process/2026-10-19_process.log.md` | 21,121 B | 只追加，含原始命令输出（P-01…P-11） |
| **F6** | `src/renderer/result.html` | 1,185 B / 24 行 | 已改：只剩结构，样式走 `<link>` |
| **F7** | `src/renderer/result.js` | 24,315 B / 671 行 | 已改：骨架/空状态/占位/浮条/兜底定时器 |
| **F8** | `tests/test_result_ui.js` | 16,237 B / 313 行 | 已改：**39 项**断言 |
| **F9** | `docs/screenshots/design-*.png` | 8 张 | 本轮效果留档（宽/选中/加载/空/窄/720/设置 540/设置 440 EN） |
| **F10** | `dist/screen-ocr-setup-0.2.1.exe`、`dist/截屏OCR-0.2.1-win.zip`、`dist/latest.yml`、`dist/SHA256SUMS-0.2.1.txt` | 175 MB / 224 MB / 349 B | **0.2.1 分发产物**；清单 url 与文件名一致 |
| **F11** | `src/renderer/styles/tokens.css` | 2,795 B / 87 行 | 新建：令牌单一来源 |
| **F12** | `src/renderer/styles/base.css` | 2,186 B / 85 行 | 新建：reset / `::selection` / 滚动条 / reduced-motion |
| **F13** | `src/renderer/styles/components.css` | 9,545 B / 398 行 | 新建：按钮/胶囊/卡片/开关/下拉/空状态/骨架/浮条 |
| **F14** | `src/renderer/styles/result.css` | 9,521 B / 396 行 | 新建：结果页布局与响应式 |
| **F15** | `src/renderer/styles/settings.css` | 7,036 B / 298 行 | 新建：设置页布局 |
| **F16** | `src/renderer/settings.html` | 6,370 B / 164 行 | 已改：接入令牌/组件，布局改弹性 |
| **F17** | `docs/result-demo.html` | 67,850 B | 自动生成（`npm run demo:html`），演示页可独立打开 |

## §6 关联关系

```
需求（2026-10-19 会话）
  │
  ├─ S1/S2 代码勘察 ──→ 假设 H1 ──→ E1 实验 ──→ K1（缺陷确认）
  │                                      └────→ K2（修复结构）
  │                                             └─→ D1 ─→ D2 ─→ T1 ─→ T2/T3 ─→ T4
  │
  ├─ R1 资源调研 ──→ K4（零依赖） ──→ D3 / D8
  │                    └─→ 借鉴：Radix 色阶 / Open Props 曲线 / floating-ui 算法
  │
  ├─ S1 + S3 ──→ K3（对比度） ──→ D5
  │              └─→ D4（测试按 hex 解析，锁死写法）
  │
  └─ K5（层级原则）──→ D6 / D7 ──→ T2 / T3
```

## §7 来源索引

| 编号 | 来源 | 取用内容 |
|---|---|---|
| **S1** | `src/renderer/styles/tokens.css` + `result.css`（原 `result.html` 内联样式已迁出） | 令牌 `tokens:1-87`、`::selection` 在 `base.css:30`、识别框三态 `result.css` 识别框段、文字块、响应式 `result.css` 末尾 |
| **S2** | `src/renderer/result.js`（625 行） | 选区节流+兜底 `:83-99`、复制反馈 `:101-115`、加载/空状态 `:117-194`、单编辑根 `:270-330`、浮条 `:498-590`、全文拼接 `:452-460` |
| **S3** | `tests/test_result_ui.js`（290 行） | hex 解析 `:70`、`padding` 断言、窄屏断言、新增状态断言 `:210+` |
| **S4** | `截屏OCR工具-Windows实现规划.md`（299 行） | 仅取架构背景；**路线 A 已废弃、`onnxruntime-node` ABI 坑已不适用**，不再引用 |
| **S5** | `src/renderer/overlay.html`（43 行） | 遮罩页主色 `#3b82f6`，确认设计语言同源 |
| **E1** | 实验输出（见 `process` P-02） | `RESULT_A` 12 字/1 行；`RESULT_B` 38 字/3 行 |
| **R1** | GitHub API 调研（2026-10-19，13 项） | stars / license / pushed_at / archived；详见 F1 第 2 节 |
| **P-04** | 过程记录 | WCAG 对比度实算与视觉层级推导 |

## §8 恢复提示（可直接粘贴到新会话）

```
项目：screen-ocr（Electron 截屏 OCR）。
先读 screen-ocr/context/CONTEXT_DIGEST.md。
T1–T8 已完成：结果页单一编辑根（.text-panel > .editor[contenteditable] > .item）、八种状态、选区浮条，
样式分层在 src/renderer/styles/{tokens,base,components}.css + {result,settings}.css。
动代码前先跑（必须传 --no-sandbox；脚本含 Electron 时用 env -u ELECTRON_RUN_AS_NODE）：
  tests/test_result_ui.js（39 项）+ tests/test_i18n_ui.js + tests/test_settings.js + node tests/test_i18n_scan.js。
约束：不要改回逐行 contentEditable；不引入 npm 依赖；--sel-bg 保持字面 hex；
      .empty 的 textContent 必须精确等于 i18n 原文案；窗口尺寸断言用 waitFor 轮询。
```

## §9 本次精简记录

**输入规模**：5 个源码/文档文件共 46,674 B（1,205 行）；加上本次两份交付物，会话内实际读入/产出合计 86,051 B。另有多轮检索与 GitHub API 输出（非文件，未计入字节统计）。

**输出规模**：本文件约 10.8 KB / 139 行（含本轮落地状态更新）。相对 86,051 B 压缩约 **87%**；只算原始代码与规划文档（46,674 B）时压缩约 **77%**。

**压缩策略**
| 动作 | 具体做法 | 依据 |
|---|---|---|
| 去重 | 13 个仓库压成 6 类淘汰原因 + 3 项借鉴；9 个问题压成 4 组（结构/状态/反馈/可读性）；8 条改造归并为 4 个阶段 | 同类项共享同一判断逻辑，逐条保留无增量信息 |
| 去过时 | 剔除规划文档的「路线 A（rapidocr JS）」「`onnxruntime-node` ABI 重编译」；两者均已被 Python sidecar 方案取代 | 不再影响任何后续决策，保留会误导 |
| 去无关 | 打包/NSIS/自动更新/托盘/多屏/i18n 压缩为「不在本次范围」 | 与选区改造无依赖关系 |
| 留结论 | K1–K5 全部保留，每条附证据与来源行号 | 结论是后续动作的前提，丢失不可重建 |
| 留依赖 | C1–C6 全部保留（版本、构建形态、DOM 契约、测试红线、数据顺序） | 缺一条就可能改出回归 |
| 留未完成 | T1–T5 保留优先级、前置、改动面、验收标准 | 「未完成」比「已完成」更需要在上下文中存活 |
| 留可追溯 | 每个论断带 `S/E/P` 编号，§6 给出关系图 | 精简不等于失去出处 |

**未纳入精简的内容**：原始命令输出、完整 CSS 代码块、仓库逐项优缺点表。它们体积大且可随时从 `F1`/`F5` 取回，属于「按需展开」层，不占常驻上下文。

## §10 本轮（P-11）实现摘要

| 维度 | 落地方式 |
|---|---|
| 结构 | 样式四层：`tokens` → `base` → `components` → 页面（result/settings）；HTML 只留语义结构 |
| 复用 | 按钮 / 胶囊 / 卡片 / 开关 / 下拉 / 空状态 / 骨架 / 浮条 全部来自 `components.css`，两个页面共用 |
| 状态 | 默认 / 悬停 / 联动 / 拖拽 / 选中 / 禁用 / 加载 / 空 / 无原图 / 焦点 / 高对比度 / 触屏 |
| 响应式 | 760px 分栏→堆叠、单屏撑满高度、窄屏行距与按钮高度、`ResizeObserver` 重算图片缩放 |
| 数据逻辑 | 未改：`screens[].items[].text`、联动索引、复制全文顺序、Enter/粘贴约束全部保持 |
| 验证 | 39 项结果页断言 + i18n UI + 设置页冒烟 + i18n 静态扫描；8 张效果截图留档 |

**新增约束**：C7（命名与状态前缀）、C8（只引 `<link>`，不复制内联样式）、C9（尺寸断言必须轮询）。
