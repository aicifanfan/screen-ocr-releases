#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PyInstaller 构建后同步模型目录（必跑，否则产物里没有模型）。

背景：
  rapidocr 的模型不在 wheel 里，运行时按 `default_models.yaml` 的 URL 下载、并用 SHA256 校验。
  PyInstaller 重新构建时，`_internal/rapidocr/models/` 是空的 —— 于是：
    - 联网时会现场下载（首次识别多等几十秒）；
    - 离线时下载失败 → ocr_server.py 的 new_engine 捕获异常 → 静默回退 balanced
      （看起来像「高精度不生效」，极难排查）。

本脚本做四件事：
  1. 把 python/models_src/ 下的模型拷进打包产物；
  2. 若 python/models_int8/ 里有量化模型，用它覆盖同名的 rec medium；
  3. 把 default_models.yaml 里对应模型的 SHA256 改成**实际文件的哈希**
     （不改会触发重新下载，量化版本会被覆盖回 fp32 —— 这是最容易踩的坑）；
  4. 默认删掉已经用不到的 det medium（accurate 档改用 small），省 60 MB。

用法：
    .venv-perf/Scripts/python.exe python/tools/sync_models.py               # 默认：fp32（推荐）
    .venv-perf/Scripts/python.exe python/tools/sync_models.py --int8        # 套用量化模型（实验）
    .venv-perf/Scripts/python.exe python/tools/sync_models.py --keep-det-medium

注意：INT8 动态量化在 rec medium 上通过了速度门槛（约 4-5x）但**精度不达标**
（退化样本 CER 0.72% → 7.2~7.9%），因此默认不启用，见 docs/优化方向筛选与推进建议.md §9。
"""
import argparse
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT / "python" / "models_src"
INT8_DIR = ROOT / "python" / "models_int8"
RAPIDOCR = ROOT / "python" / "ocr_pkg" / "ocr_server" / "_internal" / "rapidocr"
MODELS_OUT = RAPIDOCR / "models"
YAML = RAPIDOCR / "default_models.yaml"

REC_MEDIUM = "PP-OCRv6_rec_medium.onnx"
DET_MEDIUM = "PP-OCRv6_det_medium.onnx"
# yaml 里对应的 model_key（供打印用）
KEY_BY_FILE = {
    REC_MEDIUM: "multi_PP-OCRv6_rec_medium",
    DET_MEDIUM: "multi_PP-OCRv6_det_medium",
}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def set_yaml_sha(yaml_text: str, model_key: str, new_sha: str) -> str:
    """把 default_models.yaml 里某个 model_key 的 SHA256 替换掉（只动那一段）。"""
    pattern = re.compile(
        r"(?P<head>^\s*" + re.escape(model_key) + r":\s*\n"
        r"(?:[ \t]+model_dir:[^\n]*\n)"
        r"(?P<pre>[ \t]+SHA256:[ \t]*))(?P<sha>[0-9a-fA-F]{64})",
        re.MULTILINE,
    )
    if not pattern.search(yaml_text):
        raise SystemExit(f"[ERR] 在 yaml 里找不到 {model_key} 的 SHA256 段")
    return pattern.sub(lambda m: m.group("head") + new_sha, yaml_text, count=1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--int8", action="store_true",
                    help="套用 python/models_int8 里的量化模型（默认关闭：实测精度不达标）")
    ap.add_argument("--keep-det-medium", action="store_true", help="保留 det medium（默认删除）")
    args = ap.parse_args()

    if not RAPIDOCR.exists():
        print(f"[ERR] 找不到打包产物目录: {RAPIDOCR}")
        print("      先跑 npm run build-py")
        return 2
    if not SRC_DIR.exists() or not any(SRC_DIR.glob("*.onnx")):
        print(f"[ERR] 缺少模型源目录: {SRC_DIR}（应含 fp32 原始模型）")
        return 2

    MODELS_OUT.mkdir(parents=True, exist_ok=True)

    # 1. 拷 fp32 原始模型
    copied = []
    for f in sorted(SRC_DIR.glob("*.onnx")):
        dst = MODELS_OUT / f.name
        shutil.copy2(f, dst)
        copied.append(f.name)

    # 2. 按需覆盖量化版本（默认不套：实测 CER 掉到 7%+）
    applied_int8 = False
    int8_rec = INT8_DIR / REC_MEDIUM
    if not args.int8:
        pass
    elif int8_rec.exists():
        shutil.copy2(int8_rec, MODELS_OUT / REC_MEDIUM)
        applied_int8 = True

    # 3. 同步 yaml 的 SHA256（只改实际存在的模型的哈希）
    yaml_text = YAML.read_text(encoding="utf-8")
    changed = []
    for name in (REC_MEDIUM, DET_MEDIUM):
        path = MODELS_OUT / name
        if not path.exists():
            continue
        new_sha = sha256_of(path)
        key = KEY_BY_FILE[name]
        yaml_text = set_yaml_sha(yaml_text, key, new_sha)
        changed.append((name, new_sha))
    YAML.write_text(yaml_text, encoding="utf-8")

    # 4. 删掉不再使用的 det medium
    pruned = False
    if not args.keep_det_medium:
        det = MODELS_OUT / DET_MEDIUM
        if det.exists():
            det.unlink()
            pruned = True

    # 汇总
    total = sum(p.stat().st_size for p in MODELS_OUT.glob("*.onnx"))
    print(f"[ok] 已同步 {len(copied)} 个模型 -> {MODELS_OUT}")
    for name, sha in changed:
        print(f"     {name:32s} SHA256={sha[:16]}…")
    print(f"[ok] rec medium 版本：{'INT8' if applied_int8 else 'fp32'}")
    if pruned:
        print(f"[ok] 已删除 {DET_MEDIUM}（accurate 已改用 det small）")
    print(f"[ok] 模型目录合计 {total / 1048576:.0f} MB")

    # 自检：本地文件哈希必须与 yaml 一致，否则运行时会重新下载
    yaml_now = YAML.read_text(encoding="utf-8")
    bad = []
    for name, sha in changed:
        if sha not in yaml_now:
            bad.append(name)
    if bad:
        print(f"[ERR] yaml 哈希未写入：{bad}")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
