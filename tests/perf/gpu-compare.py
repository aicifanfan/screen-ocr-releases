#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CPU vs DirectML 推理耗时对比（只做数值验证，不改产品默认）。

用法：
    .venv-dml/Scripts/python.exe tests/perf/gpu-compare.py
    .venv-perf/Scripts/python.exe tests/perf/gpu-compare.py --provider cpu

测什么：
  - rec_small / rec_medium：批量 12 个 48x320 的文本行裁剪（精修的主要成本）
  - det_small：960x960 输入（整屏检测）
每个组合 warmup 2 次、计时 5 次，报中位数。
"""
import argparse
import statistics
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "python" / "ocr_pkg" / "ocr_server" / "_internal" / "rapidocr" / "models"


def make_session(path, provider, threads=16):
    so = ort.SessionOptions()
    if provider == "cpu":
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
    providers = ["CPUExecutionProvider"] if provider == "cpu" else [provider, "CPUExecutionProvider"]
    return ort.InferenceSession(str(path), sess_options=so, providers=providers)


def bench(sess, feeds, warmup=2, runs=5):
    names = [o.name for o in sess.get_outputs()]
    for _ in range(warmup):
        sess.run(names, feeds)
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        sess.run(names, feeds)
        times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times), min(times)


def rec_feeds(sess, batch=12, width=320, height=48):
    inp = sess.get_inputs()[0]
    shape = [d if isinstance(d, int) else None for d in inp.shape]
    h = shape[2] or height
    w = shape[3] or width
    return {inp.name: np.random.rand(batch, 3, h, w).astype(np.float32)}


def det_feeds(sess, size=960):
    inp = sess.get_inputs()[0]
    shape = [d if isinstance(d, int) else None for d in inp.shape]
    h = shape[2] or size
    w = shape[3] or size
    return {inp.name: np.random.rand(1, 3, h, w).astype(np.float32)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="dml", choices=["cpu", "dml", "cuda"])
    ap.add_argument("--threads", type=int, default=16)
    args = ap.parse_args()

    provider = {"cpu": "cpu", "dml": "DmlExecutionProvider", "cuda": "CUDAExecutionProvider"}[args.provider]

    print(f"provider={args.provider}  onnxruntime={ort.__version__}  available={ort.get_available_providers()}")
    if provider != "cpu" and provider not in ort.get_available_providers():
        print(f"[SKIP] {provider} 不可用")
        return

    cases = [
        ("rec_small  x12", MODELS / "PP-OCRv6_rec_small.onnx", "rec", rec_feeds),
        ("rec_medium x12", MODELS / "PP-OCRv6_rec_medium.onnx", "rec", rec_feeds),
        ("det_small 960", MODELS / "PP-OCRv6_det_small.onnx", "det", det_feeds),
    ]
    for label, path, kind, feed_fn in cases:
        if not path.exists():
            print(f"[SKIP] 缺模型 {path.name}")
            continue
        try:
            sess = make_session(path, provider, args.threads)
            med, best = bench(sess, feed_fn(sess))
            print(f"  {label:16s} median={med:8.1f} ms   best={best:8.1f} ms")
        except Exception as e:  # noqa: BLE001
            print(f"  {label:16s} 失败: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
