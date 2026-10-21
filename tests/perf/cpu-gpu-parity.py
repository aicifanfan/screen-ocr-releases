#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CPU 与 DirectML 的识别结果一致性对拍（上线门禁：差异率必须为 0）。

用法：
    .venv-perf/Scripts/python.exe tests/perf/cpu-gpu-parity.py
    .venv-perf/Scripts/python.exe tests/perf/cpu-gpu-parity.py --dir tests/perf --profile accurate

注意：只用同一份 .onnx 模型、同一套参数，唯一变量是 provider。
"""
import argparse
import base64
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "python" / "ocr_pkg" / "ocr_server" / "_internal" / "rapidocr" / "models"
REC = {"fast": "tiny", "balanced": "small", "accurate": "small"}


def build(provider, profile):
    from rapidocr import RapidOCR
    rec = REC.get(profile, "small")
    params = {
        "Global.use_cls": False,
        "Global.text_score": 0.45,
        "Det.limit_side_len": 736 if profile == "fast" else 960,
        "Det.limit_type": "max",
        "Rec.rec_batch_num": 12,
        "Det.model_path": str(MODELS / ("PP-OCRv6_det_%s.onnx" % ("tiny" if profile == "fast" else "small"))),
        "Rec.model_path": str(MODELS / ("PP-OCRv6_rec_%s.onnx" % rec)),
    }
    if provider == "dml":
        params["EngineConfig.onnxruntime.use_dml"] = True
    else:
        params["EngineConfig.onnxruntime.intra_op_num_threads"] = 16
    return RapidOCR(params=params)


def load(p):
    raw = base64.b64decode(Path(p).read_text().strip())
    return np.array(Image.open(io.BytesIO(raw)).convert("RGB"))


def texts(eng, img):
    r = eng(img)
    return [t or "" for t in (r.txts or [])]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="tests/perf")
    ap.add_argument("--profile", default="balanced", choices=list(REC))
    args = ap.parse_args()

    files = sorted(Path(args.dir).glob("*.b64"))
    if not files:
        print("[SKIP] 没有测试图")
        return 0

    cpu = build("cpu", args.profile)
    gpu = build("dml", args.profile)

    total = same = 0
    bad = []
    for f in files:
        img = load(f)
        a, b = texts(cpu, img), texts(gpu, img)
        n = min(len(a), len(b))
        total += max(len(a), len(b))
        eq = sum(1 for i in range(n) if a[i] == b[i])
        same += eq
        flag = "OK " if (len(a) == len(b) and eq == n) else "DIFF"
        print("  [%s] %-22s 行数 cpu=%d gpu=%d 相同=%d" % (flag, f.name, len(a), len(b), eq))
        if flag == "DIFF":
            for i in range(n):
                if a[i] != b[i]:
                    bad.append((f.name, i, a[i], b[i]))

    rate = same / total if total else 1.0
    print("\n总行数 %d，逐行一致 %d，一致率 %.2f%%" % (total, same, rate * 100))
    for name, i, x, y in bad[:5]:
        print("  差异 %s #%d\n    cpu=%r\n    gpu=%r" % (name, i, x, y))
    if rate < 1.0:
        print("[FAIL] 存在差异，不能上线（或只对大模型启用 GPU）")
        return 1
    print("[ALL PASS] CPU 与 GPU 结果完全一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
