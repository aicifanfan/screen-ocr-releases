#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实管线对比：CPU vs DirectML（同一张图，同一套参数）。

用法：
    .venv-perf/Scripts/python.exe tests/perf/gpu-e2e.py --provider cpu
    .venv-dml/Scripts/python.exe  tests/perf/gpu-e2e.py --provider dml

测两种「真实识别形态」：
  1. 均衡：det small + rec small 全量
  2. 精修：det small + rec medium 全量（高精度档的最终结果就是这么算的）
"""
import argparse
import base64
import io
import statistics
import time
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "python" / "ocr_pkg" / "ocr_server" / "_internal" / "rapidocr" / "models"


def build(provider, rec_type, threads=16):
    from rapidocr import RapidOCR

    params = {
        "Global.use_cls": False,
        "Global.text_score": 0.45,
        "Det.limit_side_len": 960,
        "Det.limit_type": "max",
        "Rec.rec_batch_num": 12,
        "Det.model_path": str(MODELS / "PP-OCRv6_det_small.onnx"),
        "Rec.model_path": str(MODELS / f"PP-OCRv6_rec_{rec_type}.onnx"),
    }
    if provider == "cpu":
        params["EngineConfig.onnxruntime.intra_op_num_threads"] = threads
        params["EngineConfig.onnxruntime.inter_op_num_threads"] = 1
    else:
        params["EngineConfig.onnxruntime.use_dml"] = True
    return RapidOCR(params=params)


def load_image(p):
    raw = base64.b64decode(Path(p).read_text().strip())
    return np.array(Image.open(io.BytesIO(raw)).convert("RGB"))


def timed(fn, runs=3, warmup=1):
    for _ in range(warmup):
        fn()
    ts = []
    out = None
    for _ in range(runs):
        t0 = time.perf_counter()
        out = fn()
        ts.append((time.perf_counter() - t0) * 1000)
    return statistics.median(ts), out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="cpu", choices=["cpu", "dml"])
    ap.add_argument("--image", default="tests/perf/shot-2560.b64")
    args = ap.parse_args()

    img = load_image(args.image)
    print(f"provider={args.provider}  image={img.shape[1]}x{img.shape[0]}")

    for rec_type, label in (("small", "均衡 det_small+rec_small"), ("medium", "精修 det_small+rec_medium")):
        try:
            eng = build(args.provider, rec_type)
            med, res = timed(lambda: eng(img))
            n = len(res.txts) if (res is not None and getattr(res, "txts", None)) else 0
            per = med / max(1, n)
            print(f"  {label:26s} 中位 {med:8.1f} ms  {n} 行  ≈ {per:6.0f} ms/行")
        except Exception as e:  # noqa: BLE001
            print(f"  {label:26s} 失败: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
