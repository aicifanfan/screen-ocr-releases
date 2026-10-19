#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端评测：直接驱动 ocr_server（源码或打包 exe），在 bench_images 上算 CER 与耗时。

与 bench_ocr.py 的区别：那个直接调 RapidOCR 库，这个走真实 JSON 协议，
因此能覆盖 ocr_server 里的档位 / 级联 / 后处理逻辑。

用法：
    python tools/eval_server.py --profile accurate                    # 级联（默认）
    SCREEN_OCR_CASCADE=0 python tools/eval_server.py --profile accurate
    python tools/eval_server.py --profile balanced --set hard
"""
import argparse
import base64
import io
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from bench_ocr import build_images, levenshtein, norm  # noqa: E402
from ocr_server import postprocess_text  # noqa: E402  # 与线上同一套规范化，评测才公平


def start(cmd, profile, env_extra):
    env = dict(os.environ, SCREEN_OCR_PROFILE=profile, **env_extra)
    p = subprocess.Popen(list(cmd), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=env)
    # 等 ready
    while True:
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("sidecar 未就绪就退出了")
        try:
            msg = json.loads(line.decode("utf-8").strip())
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "ready":
            return p, msg


def recognize(p, path):
    from PIL import Image
    buf = io.BytesIO()
    Image.open(path).convert("RGB").save(buf, "PNG")
    image = base64.b64encode(buf.getvalue()).decode("ascii")
    p.stdin.write((json.dumps({"type": "recognize", "image": image, "seq": 1}) + "\n").encode())
    p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("sidecar 退出了")
        msg = json.loads(line.decode("utf-8").strip())
        if msg.get("seq") == 1 and msg.get("type") in ("result", "error"):
            return msg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", default="accurate")
    ap.add_argument("--set", default="hard", choices=["easy", "hard"])
    ap.add_argument("--exe", default=str(ROOT / "python" / "ocr_pkg" / "ocr_server" / "ocr_server.exe"))
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--src", action="store_true", help="用当前 python 跑 python/ocr_server.py（源码模式）")
    args = ap.parse_args()

    exe = Path(args.exe)
    if not exe.exists():
        print(f"[ERR] 找不到 sidecar: {exe}")
        return 2

    extra = {}
    for k in ("SCREEN_OCR_CASCADE", "SCREEN_OCR_CASCADE_THRESH", "SCREEN_OCR_CASCADE_MAXRATIO",
              "SCREEN_OCR_REC_TYPE", "SCREEN_OCR_THREADS"):
        if os.environ.get(k) is not None:
            extra[k] = os.environ[k]

    cmd = [sys.executable, str(ROOT / "python" / "ocr_server.py")] if args.src else [str(exe)]
    p, ready = start(cmd, args.profile, extra)
    print(f"ready: profile={ready.get('profile')} threads={ready.get('threads')} "
          f"cascade={ready.get('cascade')} warmup={ready.get('warmup_ms')}ms")

    items = build_images(args.set)
    rows = []
    for name, path, ref in items:
        times, texts, reran = [], [], 0
        for _ in range(args.repeats):
            t0 = time.perf_counter()
            msg = recognize(p, path)
            times.append((time.perf_counter() - t0) * 1000)
            if msg.get("type") == "error":
                print(f"  [ERR] {name}: {msg.get('message')}")
                texts = []
                break
            texts = msg.get("texts") or []
            casc = msg.get("cascade") or {}
            reran = casc.get("reran", 0)
        hyp = "\n".join(texts)
        d = levenshtein(norm(ref), norm(hyp))
        cer = d / max(1, len(norm(ref)))
        rows.append({"case": name, "cer": cer, "chars": len(norm(ref)),
                     "ms": statistics.median(times), "reran": reran, "hyp": hyp})
        print("  %-22s CER=%6.2f%%  %7.0fms  reran=%d" % (name, cer * 100, rows[-1]["ms"], reran))

    total_chars = sum(r["chars"] for r in rows)
    total_err = sum(r["cer"] * r["chars"] for r in rows)
    print("\n== %s / %s ==" % (args.profile, args.set))
    print("  CER=%.2f%%   中位耗时=%.0fms   总耗时=%.0fms   平均重跑行=%.1f" % (
        total_err / max(1, total_chars) * 100,
        statistics.median([r["ms"] for r in rows]),
        sum(r["ms"] for r in rows),
        statistics.mean([r["reran"] for r in rows])))

    p.stdin.write(b'{"type":"exit"}\n')
    p.stdin.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
