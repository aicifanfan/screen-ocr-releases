# 截屏 OCR 工具

截取屏幕任意区域 → 本地 OCR 识别文字 → 渲染为可编辑文本 → 划选复制。

**核心特性**：全局快捷键唤起 / 多显示器跨屏合成 + **鼠标自由框选（鼠标在哪屏就框哪屏、可跨屏）** / 拖拽框选 + 尺寸提示 / 选区放大镜 / 本地离线 OCR（中文精度高）/ **特殊字符规范化（星号变体、全角标点 → 半角）** / 可编辑结果 + 划选复制（Ctrl+C / Ctrl+A / Esc）/ 复制后自动关闭 / 原图对照（识别框叠加，点文字定位原图位置）/ 多屏识别结果分屏分组展示 / **混合 DPI 支持（各屏不同缩放比框选依然精准）**。

> **用法**：`Ctrl+Shift+A`（或双击图标 / 托盘）唤起后，全部屏幕合成一张完整画面；**鼠标在哪块屏就在哪块屏拖拽框选**，主屏、副屏都能框，也能跨屏拖拽框选。松开鼠标即自动识别。

## 技术栈

- Electron（主 + 渲染双进程）：快捷键、托盘、截屏、剪贴板
- Python `rapidocr`（sidecar 子进程）：本地 OCR，中文精度高、离线
- 通信：Electron 主进程 `spawn` Python，stdio 逐行 JSON

## 环境要求

- Node.js LTS（22.x）
- Python 3.8+（开发期需要，打包后无需）
- Windows 10 / 11

## 快速开始

```bash
# 1. 安装 Node 依赖
npm install

# 2. 安装 Python OCR 依赖（rapidocr 本体 + onnxruntime 推理引擎，两者都要装）
pip install rapidocr onnxruntime

# 3. 运行
npm start
```

触发截屏：`Ctrl+Shift+A`（或托盘图标）。

> 若 `python` 不在默认环境，可用环境变量指定 OCR 服务的解释器：
> `SCREEN_OCR_PYTHON=/path/to/python npm start`

## 多语言（中文 / English）

界面支持中英双语，切换后**立即生效、无需刷新**，选择会持久化到 `userData/settings.json` 的 `language` 字段。

**切换入口**：托盘右键 →「设置」→ 顶部「语言」卡片（或结果页「⚙ 设置」）。

| 设置值 | 含义 |
|---|---|
| `auto`（默认） | 跟随系统语言：`zh-*` → 中文，其余 → English |
| `zh` | 强制中文 |
| `en` | 强制英文 |

**回退规则**（保证任何异常情况下界面都有内容）：

1. 配置里的值非法（如手改成 `klingon`）→ 按 `auto` 处理；
2. `auto` 且系统语言无法识别（如 `fr-FR`）→ 回落中文；
3. 某个 key 在当前语言缺失 → 回落中文文案；
4. 中英都缺失 → 直接显示 key 本身（便于发现漏译，不会白屏）。

**代码结构**：

```
src/shared/i18n.js      # 唯一文案来源：zh/en 词典 + t() + applyDom()（主进程 require、渲染进程 <script> 均可用）
```

- 主进程：窗口标题、托盘菜单/提示、更新弹窗与错误码都用 `t()`；
- 渲染进程：静态文案用 `data-i18n` / `data-i18n-title` 标记，动态文案（屏名、置信度、更新状态）用 `t('key', {参数})`；
- 语言变更由主进程 `i18n:set` 持久化后广播 `i18n:changed`，各窗口就地重绘；
- 屏名等**运行时数据不存文案**，只传 `labelKind/labelIndex`，由渲染层按当前语言生成。

**新增一门语言**：在 `src/shared/i18n.js` 的 `MESSAGES` 增加一份同 key 词典，并把语言代码加进 `LANGS` / `ALIASES`，改 `normalizeLang` 的映射即可；`tests/test_i18n.js` 会校验 key 与占位符是否对齐。

**防止漏译的三道测试**：

```bash
node tests/test_i18n.js         # 词典完整性、占位符一致性、语言解析与回退
node tests/test_i18n_scan.js    # 扫描 src/：硬编码中文残留 + 引用了不存在的 key
npx electron tests/test_i18n_ui.js    # 真实渲染：切换语言、无中文残留、长文案不撑破布局
npx electron tests/test_i18n_main.js  # 主进程链路：配置→preload→切换→持久化→广播
```

## 常见问题

- **`onnxruntime is not installed`**：`rapidocr` 不自动安装推理引擎，需手动 `pip install onnxruntime`。
- **`ELECTRON_RUN_AS_NODE=1`**：若在当前环境设置了此变量，Electron 会以纯 Node 模式运行导致启动失败；运行前 `unset ELECTRON_RUN_AS_NODE`（WorkBuddy 沙箱环境自带，用户本地一般无）。
- **无 GPU / 远程桌面**：代码已在入口调用 `app.disableHardwareAcceleration()`，走软件渲染，无需手动干预。

## 已知限制

- **非矩形屏阵（L 形）**：虚拟桌面按包围盒计算，屏与屏之间的空隙会显示为黑底，在该区域框选无文字可识别。
- **跨屏框选在混合 DPI 下**：若选区同时横跨缩放比不同的两块屏，会统一按主屏密度拼接后识别（OCR 内容不受影响，仅裁剪图以主屏密度为准）。
- **多屏瞬时一致性**：一次性抓取所有屏，同一时刻各屏基本一致；极端场景（正在播放视频）下不同屏内容仍可能有极短暂差异。

## 自测脚本

脚本统一放在 `tests/`；两条常用命令：

```bash
npm test          # 纯 Node/静态检查（i18n 词典、硬编码扫描、裁剪数学）
npm run test:ui   # Electron 渲染类（结果页 39 项、中英切换、设置页）
```

需要单跑某一项时：

```bash
# Python OCR 单点测试（符号规范化 + 中文识别，需在有 rapidocr 依赖的环境运行）
python tests/test_ocr.py

# Electron 系列自检（需 unset ELECTRON_RUN_AS_NODE）
unset ELECTRON_RUN_AS_NODE
npx electron tests/test_launch.js       # 模块加载
npx electron tests/test_capture.js      # 多屏捕获 + 混合 DPI 字段 + 屏标识
npx electron tests/test_capture_jpeg.js # JPEG 捕获 → 解码 → 像素有效 + 前后基准对比
npx electron tests/test_e2e.js          # 多屏截图→裁剪→OCR 全链路
npx electron tests/test_overlay.js      # 遮罩混合 DPI 合成 + 单屏/跨屏裁剪（像素级校验）
npx electron tests/test_clipmask.js     # clip-path 单遮罩挖洞
npx electron tests/test_overlay_full.js # 完整启动诊断：每块屏是否都被遮罩覆盖
npx electron tests/test_overlay_fresh.js# 每次截屏都是全新窗口（无嵌套/叠加）
npx electron tests/test_result.js       # 结果页多屏分组渲染 + 双向联动
npx electron tests/test_copy.js         # 复制交互（复制/连续刷新/全选/自动关闭）
npx electron tests/test_settings.js     # 设置页（快捷键录制/缩放/更新/语言入口）
npx electron tests/test_single.js       # 单实例锁 + 二次启动唤起截屏
npx electron tests/test_tray.js         # 托盘图标加载
npx electron tests/test_ocr_bridge.js   # Node → 打包 exe 的 OCR 协议链路
npx electron tests/test_i18n_ui.js      # 中英切换（无刷新、无残留、布局不溢出）
npx electron tests/test_i18n_main.js    # 语言持久化与广播链路
```

> **受限/无 GPU 环境（如 CI、WorkBuddy 沙箱）**：运行窗口渲染类自检（`test_overlay.js`）时加 `--no-sandbox --disable-gpu`，例如：
> `npx electron --no-sandbox --disable-gpu tests/test_overlay.js`。真实桌面机上直接 `npm start` 即可，无需任何额外参数。

## 目录结构

```
screen-ocr/
├── src/
│   ├── main/              # 主进程：入口 / 快捷键 / 托盘 / 截屏 / OCR 桥接 / 自动更新
│   ├── preload/           # contextBridge 安全桥接
│   ├── renderer/          # 渲染层：遮罩选区页、结果页、设置页
│   │   └── styles/        # tokens / base / components + 页面样式
│   └── shared/            # 主/渲染共用：i18n 词典
├── python/                # OCR sidecar 源码（ocr_server.py）
├── assets/                # 图标、安装脚本（installer.nsh）
├── scripts/               # 构建辅助（build-demo.js 生成演示页）
├── tests/                 # 自测脚本（Electron / Node / Python）
├── docs/                  # 设计与说明：改造方案、静态预览、演示页、截图、跑通与打包指南
├── context/               # 上下文归档：精简摘要、过程日志、冻结版本
├── electron-builder.yml   # 打包配置
└── package.json
```

## 打包发布

```bash
# 1. 安装打包工具
pip install pyinstaller

# 2. 把 Python OCR 服务打成 onedir 目录（含模型与 DLL）
npm run build-py
# 产物：python/ocr_pkg/ocr_server/ocr_server.exe（+ _internal/ 依赖目录）

# 3. 打 Windows 产物（安装包 + 免安装 zip）
npm run dist
# 产物：
#   dist/截屏OCR Setup <version>.exe   安装包（安装时可勾选是否创建桌面快捷方式）
#   dist/截屏OCR-<version>-win.zip     免安装压缩包：解压后双击 截屏OCR.exe 即可运行
```

> `electron-builder.yml` 会把整个 `python/ocr_pkg/ocr_server/` 目录作为 extraResources 带入，主进程运行时从 `process.resourcesPath/ocr_server/ocr_server.exe` 启动 sidecar。

### 安装选项：创建桌面快捷方式

安装包为「辅助安装」模式（`oneClick: false`），在「选择安装位置」之后会多出一页
**「选择附加任务」**，其中「创建桌面快捷方式」**默认勾选**，用户可在安装过程中自行取消或重新勾选。

| 场景 | 行为 |
|---|---|
| 勾选（默认） | 创建桌面快捷方式 + 开始菜单快捷方式 |
| 取消勾选 | 不创建桌面快捷方式，仍保留开始菜单项 |
| 静默安装 `安装包.exe /S` | 不显示页面，按「勾选」处理 |
| 覆盖安装 / 自动更新 | 跳过该页，不改变已有快捷方式状态 |

实现：`nsis.include: assets/installer.nsh`（自定义页面 + `customInstall` 钩子），
配合 `nsis.createDesktopShortcut: true` 由内置流程创建，若用户取消则删除刚创建的 `.lnk`。
注意脚本必须保存为 **UTF-8 with BOM**，否则中文会乱码；electron-builder 编译时已固定 `-INPUTCHARSET UTF8`。

### 分享用的 zip

`win.target` 同时包含 `nsis` 与 `zip`，zip 是 `win-unpacked` 目录的压缩包：
接收者解压后直接双击 `截屏OCR.exe` 即可使用，无需安装、无需管理员权限，
但不会创建快捷方式（需要的话自行发送到桌面）。

### 打包关键注意事项

1. **onnxruntime 版本必须 ≤ 1.20.1**：新版（如 1.31.0）与 PyInstaller 打包后会触发 `0xC0000005`（ACCESS_VIOLATION）崩溃。`npm run build-py` 前先 `pip install onnxruntime==1.20.1`。
2. **中文乱码**：PyInstaller 打包后 `sys.stdout` 默认 GBK 编码，直接输出中文会被 Electron 侧 UTF-8 解码成乱码。已在 `ocr_server.py` 的 `_emit()` 中用 `ensure_ascii=True`（输出 `\uXXXX`）+ `sys.stdout.reconfigure(encoding='utf-8')` 双保险解决，勿改回 `ensure_ascii=False`。
3. **收集依赖**：`build-py` 脚本用 `--collect-all rapidocr --collect-all onnxruntime` 收集模型文件与 onnxruntime 原生 DLL，缺一不可。

## 更新日志

### 0.2.4（2026-10-19 · 高精度档提速 1.9 倍）

**结果**：17 行长文本截图，高精度档 **16.4s → 8.9s**（同机同图 A/B，实测 1.88×）；
检测阶段（只跑 det）**2988ms → 405ms**；安装包 **272 MB → 约 215 MB**。

**改了什么**

| 项 | 内容 |
|---|---|
| 线程自适应 | `python/ocr_server.py` 原来硬编码 `min(8, cpu)`，32 核机器只用 1/4 算力。改为「留 2 核、上限 24」，可用 `SCREEN_OCR_THREADS` 覆盖 |
| 高精度档检测换小模型 | accurate 档 `Det` 由 medium 换成 small：检测只决定「框在哪、几行」，文字仍由 medium rec 识别。det 从 2.99s 降到 0.4s，精度几乎不变 |
| 启动预热 | 构造 `RapidOCR()` 并不会建立 ORT session（模型懒加载）。现在 `ready` 前显式跑一次 det+rec，把首帧开销挪到启动阶段（实测 warmup 约 1.0s） |
| 包体瘦身 | 不再随包发 det medium（60 MB），`npm run build-py` 会自动清理；模型目录 169 MB → 109 MB |

**没做什么（有实测依据）**
- **INT8 动态量化没有采用**：速度确实快 4.2–5.0×（73 MB → 18.6 MB），但在退化样本集上 CER 从 0.72% 掉到 **7.2–7.9%**（EM 77.8% → 27.8%），远超「≤ +0.7pp」的门禁。per-channel / 仅量化 Conv / QInt8 三种策略都一样（QInt8 还因缺少 `ConvInteger` 实现无法加载）。工具留在 `python/tools/quantize_rec.py`，默认不启用。
- **没有改 OCR 模型档位的语义**：fast / balanced / accurate 仍然分别是 tiny / small / medium rec，只是 accurate 的 det 降了一档。

**新增命令**
```bash
npm run build-py     # 构建侧车：优先用 .venv-perf，构建后自动同步模型（漏同步会导致静默回退 balanced）
npm run quantize     # 生成 INT8 rec 模型（实验，默认不套用）
npm run models:sync  # 只同步模型：拷贝 fp32 + 对齐 default_models.yaml 的 SHA256 + 清理 det medium
```

**自测**：结果页 43 项、i18n、设置页、复制、多屏、OCR 桥接健壮性、档位链路 全 PASS；
速度对比脚本见 `tests/perf/ab.js`（可用 `--exe` 指定旧版侧车做同机 A/B）。

### 0.2.3（2026-10-19 · 修复「切换识别精度不生效」）

**根因**：`src/main/config.js` 的 `update()` 用 `Object.assign(load(), partial)` 就地改写缓存对象；
`settings:set` 在 `update()` **之后**才比较 `partial.ocrProfile !== old.ocrProfile`，
而此时 `old` 已被改写 → 判断永远为 false → 切换档位从不通知 OCR 引擎。
表现：设置页显示「均衡」、`settings.json` 也是 balanced，但引擎一直跑 accurate（慢 10–15×）。

**修复**
- `update()` 改为替换缓存对象（`cache = { ...cache, ...partial }`），不再就地改写。
- `settings:set` 取旧值快照，并把「应用档位」放在写配置之前；成功/失败都写日志（失败时附带引擎实际档位）。
- `OcrBridge.setProfile` 只有引擎确认后才更新本地档位；采纳 `ready/profileChanged` 回报的真实档位；`warn` 不再静默。
- 启动日志新增「OCR 就绪：实际档位 X」，下次可直接从日志确认。

**临时规避（0.2.2 及更早）**：配置已是 balanced 时，**重启应用**即可让引擎按新配置启动。

**自测**：新增 `tests/test_settings_profile.js`（10 项，覆盖配置快照、切换成功/重复/非法、引擎回退不谎报）；
真实引擎同图对比 accurate 23996ms → balanced 1610ms。

### 0.2.2（2026-10-19 · 性能与健壮性）

**先给结论**：美化没有拖慢渲染（同一份数据 A/B 对比，结果页渲染仅 +3ms，页面加载时长持平）。
真正的耗时在 OCR 引擎（accurate 档 2–4.5s）与截图（0.7–1.0s），本轮把「UI 侧」的隐性等待全部去掉：

- 结果窗口改为「OCR 一开始就预建（隐藏）」，页面加载与识别并行；结果到达直接显示，省掉 ~280–560ms 的二次等待，并消除加载期白屏。
- 主进程读系统 DPI 由 `execSync` 改异步 + 启动预热：原来每次首窗都会冻结主进程 ~0.75–1.0s（期间 IPC 全排队），现在事件循环零阻塞。
- OCR 结果直传：去掉 dataURL → Buffer → base64 的两次整块拷贝，入口增加格式/体积校验。
- 遮罩页松手后显示「正在识别…」，不再让人以为卡死。

**健壮性**
- OCR 桥接：sidecar 冷启动 25s、单次识别 90s 超时；进程崩溃自动重启重试一次；写入失败/脏输出/空输入都有明确错误码。
- 主进程：结果为空不打开空白窗口；结果窗口加载/渲染失败写日志。
- 结果页：`{pending}` 时保持骨架屏（不再误判成「未识别到文字」）；坏图回退占位；字段缺失/长度不齐不抛错。

**自测**
- 结果页 39 → 43 项；新增 `tests/test_ocr_bridge_resilience.js`（假 sidecar 模拟不 ready / 不回包 / 崩溃 / 脏输出）；全量回归 PASS。

**安装包体积**
- 0.2.1 是 183 MB，0.2.2 是 272 MB：本版把「高精度」用的 medium 模型（约 140 MB）一并打包，
  首次选择高精度不再临时下载；日常建议用「均衡」，比高精度快约 10 倍。

### 0.2.1（2026-10-19 · 界面实现）

**样式工程**
- 样式拆为四层：`styles/tokens.css`（令牌）→ `base.css`（reset / 选区 / 滚动条）→ `components.css`（按钮、胶囊、卡片、开关、下拉、空状态、骨架、浮条）→ `result.css` / `settings.css`（页面）。两个窗口共用同一套令牌与组件。
- 页面只通过 `<link>` 引样式；`npm run demo:html` 会自动把样式内联进 `docs/result-demo.html`，演示页仍可单文件分享。

**结果页 · 状态补全**
- 新增加载骨架（两栏结构与真实内容同形，数据到达不跳布局，`aria-busy` 同步）。
- 空状态升级为「图标 + 文案 + 补充提示」并纵向居中；无原图时右侧显示虚线占位。
- 新增选区浮条：松开鼠标即出现「复制」，贴选区下方、放不下翻上方、滚动/塌陷/按下即收起。
- 单屏时左右分栏撑满窗口高度；窄屏改为按内容顺序堆叠，不再出现中间大片空白。
- 复制反馈修正：连续点击不会把「已复制」当成原文恢复；切换语言时丢弃旧文案。

**设置页**
- 接入同一套令牌与组件（按钮、开关、下拉、卡片）；标题区改主色实色面。
- 布局改纵向弹性（header / scroll / footer），去掉 `calc(100% - 72px - 64px)` 硬编码高度；快捷键框补键盘焦点环。

**自测**
- `test_result_ui.js` 25 → 39 项（复制反馈宽度、骨架屏与 `aria-busy`、无原图占位、空状态精确文案）全 PASS；
  `test_i18n_ui.js`、`test_settings.js`、`test_i18n_scan.js` 全 PASS；截图见 `docs/screenshots/design-*.png`。

### 0.2.0（2026-10-19）

**结果页 · 划选**
- 修复跨行划选被截断：文字区改为单一编辑容器（`.text-panel > .editor > .item`），拖选可跨多行连续选中并保留换行。
- 守住「1 行 = 1 识别框」：回车不拆行、多行粘贴自动压平，复制全文顺序与识别框一一对应。

**结果页 · 视觉**
- 选区 / 联动 / 识别框收敛为一条视觉层级：只有文本选区使用实色底，其余用描边、色条与淡底。
- 正文 14→15px；空状态文字对比度 2.56:1 → 4.76:1；按钮悬停、按下、禁用、成功态统一；拖拽期间抑制悬停底色。
- 窄屏：上下堆叠、图区限高 42vh、触摸按钮 40px、工具栏不再出现孤行按钮。
- 窗口缩放后按新宽度重算图片缩放，消除横向溢出与识别框错位。

**自测**
- `test_result_ui.js` 新增 3 条结构契约断言，共 25 项全 PASS；`test_i18n_ui.js` PASS。
