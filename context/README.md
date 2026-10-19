# 上下文归档区 · 使用规则

> 目的：把「过程」与「最终产出」物理隔离，保证过程可随时回看、最终结论不会被后续步骤覆盖或截断。
> 位置：`screen-ocr/context/`

## 目录

```
context/
├── README.md                      ← 本文件：规则与校验方法
├── CONTEXT_DIGEST.md              ← 精简上下文（后续任务优先读这个）
├── process/
│   └── 2026-10-19_process.log.md  ← 过程记录，只追加（APPEND-ONLY）
└── final/
    ├── FINAL_OCR选区改造方案_v1.md ← 冻结快照，发布后不改
    └── MANIFEST.md                 ← 版本、字节数、SHA-256、溯源映射
```

## 三条硬规则

1. **`process/` 只追加，不修改、不删除、不回填结论。**
   每条记录带 `P-编号 + 时间戳`，写「观察到什么 / 依据是什么 / 得出什么」。结论可以写，但最终交付物不写在这里。
2. **`final/` 发布即冻结。**
   需要修改时**新增 v2 文件**，不覆盖 v1；`MANIFEST.md` 记录每版的 SHA-256，任何截断或篡改都能被发现。
3. **工作副本 ≠ 冻结快照。**
   `docs/` 下的是可继续编辑的工作副本；`final/` 下的是发布时刻的字节级快照。两者不一致是正常的，靠 MANIFEST 的哈希判断"当时发布的是什么"。

## 读取顺序（给后续会话 / 新窗口）

1. `CONTEXT_DIGEST.md` —— 先看这个，约 150 行，含结论、决策、待办、约束、索引。
2. 需要细节 → `process/*.log.md` 对应段落（有证据原文与命令输出）。
3. 需要交付物 → `final/` 或 `docs/`。
4. 要动手 → 从 `CONTEXT_DIGEST.md` 的 §4「未完成事项」按优先级取任务。

## 校验

```bash
cd screen-ocr/context/final
sha256sum -c <(grep -oE '[0-9a-f]{64}  .*' MANIFEST.md)
```

Windows 下可用 PowerShell：

```powershell
Get-FileHash .\FINAL_OCR选区改造方案_v1.md -Algorithm SHA256
```

哈希与 `MANIFEST.md` 不一致 = 文件被改动过，应视为快照失效，需重新发布版本。
