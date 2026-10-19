# 冻结清单 · MANIFEST

> 本目录下的文件为**发布时刻的字节级快照**，发布后不再修改。需要变更时发布 v2，不覆盖 v1。

## v1 · 2026-10-19 15:40:03

| 文件 | 类型 | 字节 | SHA-256 |
|---|---|---:|---|
| `FINAL_OCR选区改造方案_v1.md` | 方案正文（Markdown） | 23,339 | `bdb39c13f3c27b8be8586e36ca756f0fef7b23a80026fee8ff9e59eaf950c59a` |
| `FINAL_selection-ui-preview_v1.html` | 可交互预览（单文件 HTML） | 16,038 | `30438fee31de632e3b7c3c9c82d806bbac425ca34ec6f4cb86a0a780dd41ea78` |

## 工作副本对应关系

| 快照 | 工作副本 | 说明 |
|---|---|---|
| `FINAL_OCR选区改造方案_v1.md` | `../../docs/OCR文本选择界面-美化改造方案.md` | 发布时与工作副本完全一致；后续若编辑工作副本，哈希会不同，属预期 |
| `FINAL_selection-ui-preview_v1.html` | `../../docs/selection-ui-preview.html` | 同上；预览页曾用真实指针序列自测通过（A 组 1 行 / B 组 3 行） |

## 溯源链

```
需求（会话 2026-10-19）
  → 过程记录 process/2026-10-19_process.log.md（P-00 ~ P-05）
    → 结论与决策 CONTEXT_DIGEST.md（K1~K5 / D1~D8）
      → 交付物 v1（本目录）
```

- 方案中的每条结论均可回溯到过程记录的对应编号（`K1 ← P-02`）。
- 方案中的对比度数字均由 WCAG 相对亮度公式实算，计算过程见 `P-04`。
- 方案中的仓库数据取自 GitHub API（2026-10-19），非人工记忆。

## 校验

```bash
cd screen-ocr/context/final
sha256sum "FINAL_OCR选区改造方案_v1.md" "FINAL_selection-ui-preview_v1.html"
```

哈希一致 → 快照未被截断或篡改；不一致 → 视为失效，需重新发布并登记新版本。
