# macOS 平台适配方案

> 目标：在不破坏 Windows 现有行为的前提下，让同一套代码在 macOS 上可用、可打包、可自动更新。
> 本文只讲「要做什么、为什么、先做什么」，不含具体实现补丁。

## 0. 结论与工作量

分三个里程碑，按依赖顺序推进：

| 阶段 | 目标 | 预估 |
|---|---|---|
| **M1 能跑** | 在 mac 上 `npm start` 能截图、能识别、能出结果页 | 2–3 人日 |
| **M2 能装** | 打出可安装的 `.dmg`/`.zip`，Gatekeeper 不拦 | 2–3 人日（含签名/公证等待） |
| **M3 能更新** | 走 GitHub Release 自动更新（`latest-mac.yml`） | 1 人日 + 1 次换机验证 |

**最大风险不在打包，而在坐标模型**：当前整套裁剪/识别框逻辑建立在「CSS 像素 == 物理像素」这个
Windows 前提下（靠 `force-device-scale-factor=1` 成立）。macOS 的 Retina 屏（scaleFactor=2）
会直接冲击这个前提，必须先在真机上做一次验证（P0-1），再决定改造方式。

---

## 1. 平台兼容性差异矩阵

| # | 现实现 | macOS 上会发生什么 | 需要做什么 |
|---|---|---|---|
| 1 | `app.commandLine.appendSwitch('force-device-scale-factor', '1')`；`crop-math.js` 假定 `physX/pxWidth` 就是物理像素 | Retina 屏 `display.bounds` 是 DIP（1440×900），物理是 2880×1800。强制 1x 后：截图按 DIP 尺寸取 → **分辨率减半**，选区坐标与图片像素**差 2 倍** → 裁剪错位、识别框偏移 | **P0 验证**：在 mac 上打印 `display.bounds / size / scaleFactor` 与 `thumbnail.getSize()`；再决定「mac 不强制 1x，按 scaleFactor 换算」还是「继续 1x 但统一乘 scale」 |
| 2 | `getSystemScaleFactor()` 读 Windows 注册表（`AppliedDPI`，经 `execFile` 调 PowerShell） | mac 上没有注册表与 PowerShell → 抛错 → 回落到 1 → 设置页/结果页在高分屏上**偏小** | 按平台分支：darwin 用 `screen.getPrimaryDisplay().scaleFactor`；win 保留注册表读取 |
| 3 | `_resolvePython()` 里打包路径写死 `ocr_server/ocr_server.exe` | mac 侧车没有 `.exe` 后缀（`ocr_server/ocr_server`）→ 找不到 → 每次识别都 `E_OCR_SPAWN` | 按平台拼文件名；更好：按「存在即用」探测（`.exe` → 无后缀 → `ocr_server.bin`） |
| 4 | 开发期 Python 路径 `.venv-perf/Scripts/python.exe` | mac 虚拟环境是 `.venv-perf/bin/python3` → 开发模式起不来 | 统一走一个 `scripts/py.js`（按平台返回 `Scripts/python.exe` 或 `bin/python3`），测试与脚本共用 |
| 5 | 直接 `desktopCapturer.getSources()` | 未授权「屏幕录制」时**不报错**，返回只有桌面壁纸的黑图 → 用户看到「截了个空屏」 | 首次启动检测 `systemPreferences.getMediaAccessStatus('screen')`，未授权时引导去「系统设置 → 隐私与安全性 → 屏幕录制」，并提示**授权后需重启应用** |
| 6 | 没有 `Menu.setApplicationMenu` | mac 的菜单栏由应用提供；没有 Edit 菜单 → 结果页里 **Cmd+C / Cmd+V / Cmd+A 全部失效**（用户最常用的操作） | 建最小菜单：`app`（About/Quit）+ `edit`（role: cut/copy/paste/selectAll）+ `window` |
| 7 | 托盘用 `tray16.png` + `tray.png`（彩色，带 .ico 兜底） | mac 菜单栏需要 **Template 图**（纯黑 + 透明，系统自动反色）；彩色图在深色菜单栏上几乎看不清 | 增加 `trayTemplate.png`/`trayTemplate@2x.png`，`image.setTemplateImage(true)`（仅 darwin） |
| 8 | 遮罩窗口：`frame:false` + `alwaysOnTop(true,'screen-saver')` + `setBounds` 物理坐标 | 多 Space / 全屏应用下可能**盖不住**或切 Space 后消失 | darwin 追加 `win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`；必要时用 `simpleFullscreen` |
| 9 | 常驻托盘，无主窗口 | mac 上默认会占一个 Dock 图标，点它却没窗口 | `app.dock.hide()`（或打包时 `LSUIElement: true`），并把「打开设置」入口留在托盘菜单 |
| 10 | 默认快捷键 `CommandOrControl+Shift+A` | mac 上是 Cmd+Shift+A，可能与系统/输入法冲突；`globalShortcut.register` 失败时只写日志 | 首启校验注册结果，失败时提示改键；默认值可考虑 `CommandOrControl+Shift+O` 之类更少冲突的组合 |
| 11 | `app.setLoginItemSettings({ openAtLogin })` | macOS 13+ 走 SMAppService，需要 `openAsHidden` 语义；失败往往**静默** | 按平台补参数；保存后回读一次状态，失败要在设置页给出明确提示 |
| 12 | 自动更新（electron-builder + GitHub） | mac 需要 `zip` 目标 + `latest-mac.yml`，且**必须已签名**，否则 Squirrel 拒绝安装 | 增加 mac 发布配置；产物名保持 ASCII（与 `latest-mac.yml` 里的 `url` 对齐） |
| 13 | 默认 `disableGpu: true`（Windows 兼容模式） | mac 关掉 GPU 合成会明显更卡（尤其拖选遮罩），且 mac 显卡驱动崩溃概率低 | 默认值按平台区分：darwin 默认开 GPU，崩溃回退机制保留 |
| 14 | 崩溃回退里含 `--no-sandbox` 等 Chromium 开关 | mac 的沙箱语义不同，这些开关对稳定性帮助有限 | 回退逻辑只对 win32 启用 |

---

## 2. 依赖与环境配置

### 2.1 Python 侧车（关键：不能跨平台构建）

- `PyInstaller` 产物与平台绑定，**必须在 macOS 上构建 `ocr_server`**（Windows 的 exe 不能复用）。
- 依赖版本保持钉死（与 `_internal/*.dist-info` 一致）：`rapidocr==3.10.0`、`onnxruntime==1.20.1`、`numpy==2.5.4`、`onnx`、`pyinstaller`。
- Apple Silicon 需要 **arm64 wheel**：先在目标机执行 `pip download onnxruntime==1.20.1 --only-binary=:all:` 确认有 `macosx_*_arm64` 轮子，再建 `.venv-perf`。
- `python/tools/sync_models.py` 里的「默认删除 det medium、INT8 可选」逻辑与平台无关，可直接复用；模型文件（109 MB）跨平台通用。
- 侧车是 CLI 程序（stdio JSON），mac 上不需要 `.app` 包装，PyInstaller 用默认 onedir 即可。

### 2.2 Node / Electron

- 无需改动：Electron 31.7.7 自带 darwin x64/arm64；`npm ci` 即可。
- 需要改的是**脚本路径**：`package.json` 里 `quantize`/`models:sync` 写死了 `Scripts/python.exe`。

### 2.3 签名与公证（M2 的前置）

| 项 | 用途 | 备注 |
|---|---|---|
| Apple Developer Program（$99/年） | 出证书 | 必需，否则 Gatekeeper 拦截 |
| `Developer ID Application` 证书 | 给 .app 与侧车签名 | 侧车是 Mach-O，**必须单独签** |
| App 专用密码 / App Store Connect API Key | 公证（notarytool） | CI 里用环境变量注入 |
| `hardenedRuntime: true` + entitlements | 公证硬性要求 | Electron 需要 `allow-jit`、`allow-unsigned-executable-memory` |

---

## 3. 构建与打包

### 3.1 electron-builder 需要新增的配置（示意）

```yaml
mac:
  target:
    - dmg
    - zip                 # 自动更新用 zip（dmg 给手动安装）
  icon: assets/icon.icns
  category: public.app-category.productivity
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: assets/entitlements.mac.plist
  entitlementsInherit: assets/entitlements.mac.plist
  artifactName: screen-ocr-${version}-mac-${arch}.${ext}   # ASCII，且要与 latest-mac.yml 对齐
dmg:
  artifactName: screen-ocr-${version}-mac-${arch}.${ext}
afterSign: scripts/notarize.js      # 或 electron-builder 内置 notarize 配置
```

要点：
1. **`extraResources` 结构不变**（`ocr_server/`），但里面是 Mach-O 可执行文件 → 必须签名，
   否则公证会报「有未签名可执行文件」；可用 `mac.binaries` 或 `afterPack` 里对 sidecar 单独 `codesign --deep`。
2. **架构**：x64 与 arm64 各出一套（含各自的侧车），运行时按 `process.arch` 选目录；
   想发 universal 包则要 `lipo` 合并两套侧车，成本高、收益低，建议先分架构发包。
3. **`latest-mac.yml`** 由 electron-builder 生成，`url` 必须与磁盘文件名一致（0.2.1 在 Windows 上踩过这个坑）。
4. 打包机器必须是 mac（侧车构建 + 签名 + 公证都依赖它）；GitHub Actions 用 `macos-14`（arm64）+ `macos-13`（x64）。

### 3.2 发布物命名

沿用现有约定，全部 ASCII：

```
screen-ocr-setup-0.4.0.exe          # win 安装包
screen-ocr-0.4.0-win.zip            # win 免安装
screen-ocr-0.4.0-mac-arm64.dmg      # mac 安装包（Apple Silicon）
screen-ocr-0.4.0-mac-arm64.zip      # mac 自动更新包
latest.yml / latest-mac.yml
```

---

## 4. 运行与测试验证

### 4.1 权限引导（影响首次体验）

```
启动 → getMediaAccessStatus('screen')
  ├─ granted   → 正常
  ├─ not-determined → 触发一次截屏（系统会弹授权），或提示手动开启
  └─ denied    → 明确提示 + 按钮跳「系统设置 → 隐私与安全性 → 屏幕录制」
                并说明「授权后需重启本应用」（macOS 的限制，进程级生效）
```

### 4.2 必须真机验证的场景（坐标/显示相关）

| 场景 | 验收点 |
|---|---|
| Retina 主屏单屏 | 选区尺寸 == 识别框范围，图片清晰（不是被放大糊掉的） |
| Retina + 外接 1x 屏（混合 DPI） | 跨屏框选后，两块区域的文字都对齐、无偏移 |
| 缩放设置为「更多空间 / 更大文字」 | 同上 |
| 副屏在主屏左侧（负坐标） | 反向框选（从右下往左上拖）仍正确 |
| 全屏应用 / 新 Space | 遮罩能盖在这之上，Esc 能退出 |
| 刘海屏（MacBook Pro） | 遮罩不被安全区裁掉 |

### 4.3 自动化测试

- 现有测试基本可复用：`test_result_ui.js`（57 项）、`test_i18n_ui.js`、`test_settings.js`、
  `test_progressive.js`、`test_refined_merge.js`、`tests/perf/queue.js`。
- **需要改的**：所有写死 `ocr_server.exe`、`.venv-perf/Scripts/python.exe`、`path.sep` 的地方
  （`tests/perf/*.js`、`tests/test_i18n_main.js`、`package.json` scripts）。
- `test_app_smoke.js` 读 `startup.log` 的逻辑与平台无关，可直接用。
- 建议加一条「平台冒烟」：启动 → 检查 `OCR 就绪` → 通过 IPC 触发一次截屏（或用固定图直接调 sidecar）。

---

## 5. 优先级清单（可按序勾选）

### P0 — 让 mac 上能跑（2–3 人日）

- [ ] **P0-1 坐标 spike（0.5d）**：在 mac 上打印 `display.bounds/size/scaleFactor`、`thumbnail.getSize()`、
      选区坐标，确认 Retina 下是否 1:1；据此决定改造方案（**先做这个，别先动打包**）
- [ ] P0-2 `getSystemScaleFactor()` 平台分支（win 注册表 / mac `display.scaleFactor`）
- [ ] P0-3 `_resolvePython()` 支持无扩展名可执行文件；`.venv-perf` 路径按平台（0.2d）
- [ ] P0-4 屏幕录制权限检测与引导（0.5d）
- [ ] P0-5 应用菜单（app/edit/window）+ 快捷键默认值复核（0.3d）
- [ ] P0-6 托盘 Template 图 + `app.dock.hide()`（0.3d）
- [ ] P0-7 mac 上 `npm run build-py` 跑通，`npm start` 手动走一遍：框选 → 识别 → 复制（0.5d）

### P1 — 让它能安装、能更新（2–3 人日）

- [ ] P1-1 electron-builder mac 配置 + `icon.icns` + entitlements（0.5d）
- [ ] P1-2 侧车签名（`extraResources` 里的 Mach-O）+ 主应用签名（0.3d）
- [ ] P1-3 公证（notarytool）+ 装到干净机器验证 Gatekeeper（0.5d，含等待）
- [ ] P1-4 `latest-mac.yml` + GitHub Release 资产命名对齐（0.3d）
- [ ] P1-5 测试与脚本的跨平台路径改造，跑通全部断言（0.5d）

### P2 — 体验与长尾（1–2 人日）

- [ ] P2-1 GPU 默认值按平台区分（mac 默认开 GPU）
- [ ] P2-2 开机自启在 macOS 13+ 的校验与提示
- [ ] P2-3 双架构构建矩阵（x64/arm64 各出侧车与包）或 CI 自动构建
- [ ] P2-4 README / 教程补 mac 安装与权限说明
- [ ] P2-5 菜单栏文案与快捷键显示（`Super` vs `CommandOrControl` 已有 `accelerator.js` 支持，需核对显示）

---

## 6. 主要注意事项

1. **不要为了 mac 改 Windows 的坐标假设**。`crop-math.js` 是纯函数，正确做法是把「scaleFactor 换算」抽成参数/适配层，
   而不是把 `physX` 的含义改掉——Windows 的 1:1 前提是有意为之（混合 DPI 下最省事）。
2. **Retina 上图片和识别框必须同源缩放**：一旦出现「图清晰但框偏移」，先查是不是一边用了物理像素、一边用了 DIP。
3. **授权是进程级的**：用户在系统设置里勾上「屏幕录制」后，正在运行的进程仍然拍不到画面，必须重启应用
   （引导文案里要写清楚，否则会被当成 bug）。
4. **公证不是可选项**：未签名的 mac 包在别人机器上会被 Gatekeeper 直接拦下；而自动更新（Squirrel）对签名是硬要求。
5. **侧车必须单独签名**：`extraResources` 里的可执行文件不会自动被签，容易在公证阶段才暴露。
6. **文件名保持 ASCII**：`latest.yml` / `latest-mac.yml` 里的 `url` 必须与磁盘一致（0.2.1 已踩过一次 404）。
7. **构建必须在 mac 上做**：Windows 机器无法产出 mac 侧车，别指望在 CI 之外临时补。
8. **测试里别写死平台路径**：`.exe`、`Scripts/python.exe`、`path.sep` 这三类在 mac 上全部会挂。
9. **先用 `npm start` 打通链路再碰打包**：签名/公证一轮要十几分钟，坐标问题在开发模式下 3 秒就能看出来。
