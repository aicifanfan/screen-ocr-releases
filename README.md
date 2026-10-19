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

## 常见问题

- **`onnxruntime is not installed`**：`rapidocr` 不自动安装推理引擎，需手动 `pip install onnxruntime`。
- **`ELECTRON_RUN_AS_NODE=1`**：若在当前环境设置了此变量，Electron 会以纯 Node 模式运行导致启动失败；运行前 `unset ELECTRON_RUN_AS_NODE`（WorkBuddy 沙箱环境自带，用户本地一般无）。
- **无 GPU / 远程桌面**：代码已在入口调用 `app.disableHardwareAcceleration()`，走软件渲染，无需手动干预。

## 已知限制

- **非矩形屏阵（L 形）**：虚拟桌面按包围盒计算，屏与屏之间的空隙会显示为黑底，在该区域框选无文字可识别。
- **跨屏框选在混合 DPI 下**：若选区同时横跨缩放比不同的两块屏，会统一按主屏密度拼接后识别（OCR 内容不受影响，仅裁剪图以主屏密度为准）。
- **多屏瞬时一致性**：一次性抓取所有屏，同一时刻各屏基本一致；极端场景（正在播放视频）下不同屏内容仍可能有极短暂差异。

## 自测脚本

```bash
# Python OCR 单点测试（符号规范化 + 中文识别，需在有 rapidocr 依赖的环境运行）
python test_ocr.py

# Electron 系列自检（需 unset ELECTRON_RUN_AS_NODE）
unset ELECTRON_RUN_AS_NODE
npx electron test_launch.js      # 模块加载
npx electron test_capture.js     # 多屏捕获 + 混合 DPI 字段 + 屏标识
npx electron test_e2e.js         # 多屏截图→裁剪→OCR 全链路
npx electron test_overlay.js     # 遮罩页混合 DPI 合成 + 单屏/跨屏裁剪（像素级校验）
npx electron test_overlay_full.js# 完整启动主进程诊断渲染
npx electron test_result.js      # 结果页多屏分组渲染 + 双向联动 + 兼容
npx electron test_copy.js        # 复制交互（复制/连续刷新/全选/自动关闭）
npx electron test_tray.js        # 托盘图标加载
npx electron test_single.js      # 单实例锁 + 二次启动唤起截屏
```

> **受限/无 GPU 环境（如 CI、WorkBuddy 沙箱）**：运行窗口渲染类自检（`test_overlay.js`）时加 `--no-sandbox --disable-gpu`，例如：
> `npx electron --no-sandbox --disable-gpu test_overlay.js`。真实桌面机上直接 `npm start` 即可，无需任何额外参数。

## 目录结构

```
screen-ocr/
├── python/ocr_server.py     # Python OCR 服务（stdio JSON）
├── src/
│   ├── main/                # 主进程：入口/快捷键/托盘/截屏/OCR桥接/剪贴板
│   ├── preload/index.js     # contextBridge 安全桥接
│   └── renderer/            # 渲染进程：遮罩选区页 + 结果文本页
└── electron-builder.yml     # 打包配置
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
