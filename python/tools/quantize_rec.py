#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 rec medium 模型做成 INT8 动态量化版本（离线一次性，产物本地保留）。

用法：
    .venv-perf/Scripts/python.exe python/tools/quantize_rec.py
    .venv-perf/Scripts/python.exe python/tools/quantize_rec.py --per-channel
    .venv-perf/Scripts/python.exe python/tools/quantize_rec.py --weight-type qint8

产物：python/models_int8/PP-OCRv6_rec_medium.onnx
之后由 python/tools/sync_models.py 覆盖进打包产物并同步 default_models.yaml 的 SHA256。

为什么不用静态量化：静态量化需要校准集（要跑一遍前向收集 activation 范围），
而动态量化只量化权重、activation 在推理时动态求范围，无需校准，
对「构建期一次、CPU 推理」的场景性价比最高。
"""
import argparse
import hashlib
import shutil
import sys
import tempfile
from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "python" / "models_src" / "PP-OCRv6_rec_medium.onnx"
OUT_DIR = ROOT / "python" / "models_int8"
OUT = OUT_DIR / "PP-OCRv6_rec_medium.onnx"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weight-type", default="quint8", choices=["quint8", "qint8"],
                    help="权重量化类型，默认 quint8（CPU 上通常更快）")
    ap.add_argument("--per-channel", action="store_true",
                    help="逐通道量化（精度略好、体积略大、不一定更快）")
    ap.add_argument("--only-conv", action="store_true",
                    help="只量化 Conv（跳过 MatMul/Gemm）：rec 模型的注意力层对量化更敏感时用这个")
    args = ap.parse_args()

    if not SRC.exists():
        print(f"[ERR] 源模型不存在: {SRC}")
        print("      先跑一次 python/ocr_server.py（accurate 档）让它下载，或手动放到该路径")
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    weight_type = QuantType.QUInt8 if args.weight_type == "quint8" else QuantType.QInt8

    print(f"[1/3] 源模型 {SRC.name}  {SRC.stat().st_size / 1048576:.1f} MB")
    print(f"[2/3] 量化中… weight_type={args.weight_type} per_channel={args.per_channel}")

    # onnxruntime 的量化器会在源文件旁边生成 `xxx-inferred.onnx` 再读回来，
    # 路径含中文时这一步会静默失败（FileNotFoundError），所以在纯 ASCII 的临时目录里做。
    work = Path(tempfile.mkdtemp(prefix="ocrq_", dir="C:/tmp" if Path("C:/tmp").is_dir() else None))
    try:
        tmp_src = work / "src.onnx"
        tmp_dst = work / "dst.onnx"
        shutil.copy2(SRC, tmp_src)
        extra = {}
        if args.only_conv:
            extra["op_types_to_quantize"] = ["Conv"]
        quantize_dynamic(
            model_input=str(tmp_src),
            model_output=str(tmp_dst),
            weight_type=weight_type,
            per_channel=args.per_channel,
            **extra,
        )
        if not tmp_dst.exists() or tmp_dst.stat().st_size == 0:
            print("[ERR] 量化失败：没有产出文件")
            return 3
        shutil.copy2(tmp_dst, OUT)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    if not OUT.exists() or OUT.stat().st_size == 0:
        print("[ERR] 量化失败：没有产出文件")
        return 3

    print(f"[3/3] 完成 {OUT}")
    print(f"      {OUT.stat().st_size / 1048576:.1f} MB  "
          f"（原始 {SRC.stat().st_size / 1048576:.1f} MB）")
    print(f"      SHA256 {sha256_of(OUT)}")
    print("\n下一步：python/tools/sync_models.py  （或直接 npm run build-py，会自动调用）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
