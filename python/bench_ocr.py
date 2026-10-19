# -*- coding: utf-8 -*-
"""OCR 基准测试：合成带 ground truth 的图片，评测「速度 + 准确度」。

指标：
  - CER  字符错误率 = (替换+删除+插入) / 参考字符数（忽略空白后比较），越低越好
  - EM   整图完全匹配率（忽略空白后完全一致）
  - ms   单图识别耗时中位数

用法：
  python bench_ocr.py --config baseline
  python bench_ocr.py --config optimized
  python bench_ocr.py --compare          # 依次跑两组并输出对比
"""
import argparse
import io
import json
import os
import statistics
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import rapidocr
from rapidocr import RapidOCR
from rapidocr.utils.typings import ModelType

HERE = os.path.dirname(os.path.abspath(__file__))
IMG_DIR = os.path.join(HERE, "bench_images")
CN_FONT = r"C:\Windows\Fonts\msyh.ttc"
EN_FONT = r"C:\Windows\Fonts\consola.ttf"

# ---- 测试样本：(名称, 文本行, 字号, 背景色, 前景色, 画布宽) ----
CASES = [
    ("cn_small_13", ["订单编号：A20241019001", "合计金额 ￥1,280.00"], 13, (255, 255, 255), (0, 0, 0), 520),
    ("cn_small_15", ["请于 10 月 20 日前完成付款", "逾期将产生滞纳金 0.05%"], 15, (255, 255, 255), (0, 0, 0), 560),
    ("cn_mid_20", ["系统提示：网络连接已恢复", "当前版本 v0.1.1 (build 2026)"], 20, (255, 255, 255), (0, 0, 0), 700),
    ("cn_large_28", ["危险：请勿触摸高温部件"], 28, (255, 255, 255), (0, 0, 0), 780),
    ("en_small_13", ["Error: ENOENT no such file", "at Object.<anonymous> (app.js:12:5)"], 13, (255, 255, 255), (0, 0, 0), 600),
    ("en_mid_18", ["HTTP 200 OK  Content-Type: application/json", "{\"code\": 0, \"msg\": \"success\"}"], 18, (255, 255, 255), (0, 0, 0), 760),
    ("mix_16", ["用户名：admin_2026  密码：Pa$$w0rd!", "验证码：X7K9*Q  （区分大小写）"], 16, (255, 255, 255), (0, 0, 0), 720),
    ("symbols_18", ["* 星号测试 *  #井号#  @at@  &amp;  100%  3*4=12"], 18, (255, 255, 255), (0, 0, 0), 720),
    ("num_table_15", ["项目      单价      数量      小计", "苹果      6.50       3        19.50", "香蕉      3.20      10        32.00"], 15, (255, 255, 255), (0, 0, 0), 640),
    # 深色主题截图（白字深底）
    ("dark_15", ["深色模式下的文字识别测试", "Terminal $ npm run dist"], 15, (30, 33, 42), (235, 235, 235), 620),
    # 低对比度（浅灰底 + 深灰字）
    ("lowcontrast_15", ["低对比度文本：请确认后再提交", "reference: 2.5 : 1 contrast"], 15, (245, 245, 245), (150, 150, 150), 620),
    # 极小字号
    ("tiny_11", ["最小字号测试 11px 是否可识别"], 11, (255, 255, 255), (0, 0, 0), 460),
]


def _font(size, text):
    ascii_only = all(ord(c) < 128 for c in text)
    path = EN_FONT if ascii_only else CN_FONT
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype(CN_FONT, size)


# 难样本用的退化方式：模拟真实截屏中的模糊、缩放失真、JPEG 压缩
DEGRADATIONS = ("blur", "down", "jpeg")


def degrade(img, kind):
    from PIL import ImageFilter
    if kind == "blur":
        return img.filter(ImageFilter.GaussianBlur(1.1))
    if kind == "down":
        w, h = img.size
        small = img.resize((max(1, int(w * 0.5)), max(1, int(h * 0.5))), Image.BILINEAR)
        return small.resize((w, h), Image.BILINEAR)
    if kind == "jpeg":
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=45)
        buf.seek(0)
        return Image.open(buf).convert("RGB")
    return img


def build_images(setname="easy"):
    """生成测试图（已存在则复用），返回 [(name, path, ref_text)]"""
    os.makedirs(IMG_DIR, exist_ok=True)
    out = []
    # hard 模式取一半样本做退化，控制评测耗时
    cases = CASES[::2] if setname == "hard" else CASES
    for name, lines, size, bg, fg, width in cases:
        path = os.path.join(IMG_DIR, name + ".png")
        font = _font(size, "".join(lines))
        pad = max(10, size // 2)
        line_h = int(size * 1.55)
        height = pad * 2 + line_h * len(lines)
        img = Image.new("RGB", (width, height), bg)
        draw = ImageDraw.Draw(img)
        for i, line in enumerate(lines):
            draw.text((pad, pad + i * line_h), line, font=font, fill=fg)
        img.save(path)
        ref = "\n".join(lines)
        out.append((name, path, ref))

        if setname == "hard":
            for kind in DEGRADATIONS:
                hpath = os.path.join(IMG_DIR, "%s_%s.png" % (name, kind))
                degrade(img, kind).save(hpath)
                out.append(("%s_%s" % (name, kind), hpath, ref))
        # hard 模式只保留退化样本，避免与 easy 重复统计
    if setname == "hard":
        out = [x for x in out if x[0].endswith(DEGRADATIONS)]
    return out


def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def norm(s):
    """评测时忽略空白差异（OCR 的空格数量不稳定）"""
    return "".join(str(s).split())


# ---------------- 预处理 ----------------

def preprocess(img, mode):
    """mode: none / upscale / enhance / upscale+enhance"""
    if mode == "none" or not mode:
        return img

    from PIL import ImageEnhance, ImageFilter

    out = img
    if "upscale" in mode:
        # 小图放大：短边不足 640 时放大到 640（Lanvzos），显著改善小字号识别
        w, h = out.size
        short = min(w, h)
        if short < 640:
            k = min(2.5, 640.0 / max(1, short))
            if k > 1.05:
                out = out.resize((int(w * k), int(h * k)), Image.LANCZOS)

    if "enhance" in mode:
        # 浅灰底深灰字这类低对比度场景：轻度锐化 + 对比度提升
        out = out.filter(ImageFilter.SHARPEN)
        out = ImageEnhance.Contrast(out).enhance(1.35)

    return out


# ---------------- 识别 ----------------

# ---------------- 参数配置（消融用） ----------------
# 基线 = rapidocr 默认（Det.limit_type=min，短边强制放大到 736，小选区会被放大十几倍）
CONFIGS = {
    "baseline": {},
    # 关键修复：只限制大图，不放大小图
    "det_max": {"Det.limit_side_len": 960, "Det.limit_type": "max"},
    # + 跳过 180° 方向分类（截图文字基本水平）
    "no_cls": {"Det.limit_side_len": 960, "Det.limit_type": "max", "Global.use_cls": False},
    # + 增大识别批大小
    "batch12": {"Det.limit_side_len": 960, "Det.limit_type": "max", "Global.use_cls": False,
                "Rec.rec_batch_num": 12},
    # + 固定线程数（-1 会用满所有核，线程调度开销可能更大）
    "threads8": {"Det.limit_side_len": 960, "Det.limit_type": "max", "Global.use_cls": False,
                 "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
    # 最终推荐组合
    "optimized": {"Global.use_cls": False, "Global.text_score": 0.45,
                  "Det.limit_side_len": 960, "Det.limit_type": "max",
                  "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
    # 极限速度：检测输入压到 736
    "fast_736": {"Global.use_cls": False, "Global.text_score": 0.45,
                 "Det.limit_side_len": 736, "Det.limit_type": "max",
                 "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
    # 极限精度：检测输入放大到 1280
    "acc_1280": {"Global.use_cls": False, "Global.text_score": 0.45,
                 "Det.limit_side_len": 1280, "Det.limit_type": "max",
                 "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
    # 更大模型（medium）：精度换速度
    "acc_medium": {"Global.use_cls": False, "Global.text_score": 0.45,
                   "Det.limit_side_len": 960, "Det.limit_type": "max",
                   "Det.model_type": ModelType.MEDIUM, "Rec.model_type": ModelType.MEDIUM,
                   "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
    # 最小模型（tiny）：速度换精度
    "fast_tiny": {"Global.use_cls": False, "Global.text_score": 0.45,
                  "Det.limit_side_len": 736, "Det.limit_type": "max",
                  "Det.model_type": ModelType.TINY, "Rec.model_type": ModelType.TINY,
                  "Rec.rec_batch_num": 12, "EngineConfig.onnxruntime.intra_op_num_threads": 8},
}


def make_engine(cfg_name):
    return RapidOCR(params=CONFIGS.get(cfg_name, {}))


def extract(res):
    """兼容 3.x，返回 (texts, scores)"""
    if hasattr(res, "txts"):
        texts = [str(t) for t in (res.txts or []) if t is not None]
        scores = [float(s) for s in (res.scores or [])] if getattr(res, "scores", None) is not None else []
        return texts, scores
    return [], []


def run(cfg_name, pre_mode, repeats=2, verbose=True, setname="easy"):
    engine = make_engine(cfg_name)
    items = build_images(setname)

    rows = []
    # 预热（模型首跑开销大，不计入）
    warm = Image.open(items[0][1]).convert("RGB")
    engine(np.array(preprocess(warm, pre_mode)))

    for name, path, ref in items:
        img = Image.open(path).convert("RGB")
        img = preprocess(img, pre_mode)
        arr = np.array(img)

        times = []
        texts = []
        for _ in range(repeats):
            t0 = time.perf_counter()
            res = engine(arr)
            times.append((time.perf_counter() - t0) * 1000)
            texts, scores = extract(res)

        hyp = "\n".join(texts)
        d = levenshtein(norm(ref), norm(hyp))
        cer = d / max(1, len(norm(ref)))
        em = 1 if norm(ref) == norm(hyp) else 0
        ms = statistics.median(times)
        rows.append({"case": name, "cer": round(cer, 4), "em": em, "ms": round(ms, 1),
                     "chars": len(norm(ref)), "hyp": hyp.replace("\n", " | ")})
        if verbose:
            print("  %-16s CER=%6.2f%%  EM=%d  %7.1fms" % (name, cer * 100, em, ms))

    total_chars = sum(r["chars"] for r in rows)
    total_err = sum(r["cer"] * r["chars"] for r in rows)
    summary = {
        "config": cfg_name,
        "preprocess": pre_mode,
        "cer": round(total_err / max(1, total_chars), 4),
        "em_rate": round(sum(r["em"] for r in rows) / len(rows), 4),
        "ms_median": round(statistics.median([r["ms"] for r in rows]), 1),
        "ms_total": round(sum(r["ms"] for r in rows), 1),
        "rows": rows,
    }
    return summary


def show(summary):
    print("\n== %s / preprocess=%s ==" % (summary["config"], summary["preprocess"]))
    for r in summary["rows"]:
        print("  %-16s CER=%6.2f%%  EM=%d  %7.1fms   %s" % (
            r["case"], r["cer"] * 100, r["em"], r["ms"], r["hyp"][:60]))
    print("  ---- 总体: CER=%.2f%%  EM=%.1f%%  中位耗时=%.1fms  总耗时=%.0fms" % (
        summary["cer"] * 100, summary["em_rate"] * 100, summary["ms_median"], summary["ms_total"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="baseline")
    ap.add_argument("--preprocess", default="none")
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--ablation", action="store_true", help="逐项消融对比")
    ap.add_argument("--set", default="easy", choices=["easy", "hard"], help="样本集：easy 清晰图 / hard 退化图")
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    print("rapidocr:", getattr(rapidocr, "__version__", "?"),
          "| 样本集:", args.set)
    results = []
    if args.ablation:
        if args.set == "hard":
            seq = [("baseline", "none"), ("optimized", "none"),
                   ("optimized", "enhance"), ("acc_medium", "none"), ("fast_tiny", "none")]
        else:
            seq = [("baseline", "none"), ("det_max", "none"), ("no_cls", "none"),
                   ("batch12", "none"), ("threads8", "none"), ("optimized", "none"),
                   ("fast_736", "none"), ("acc_1280", "none"),
                   ("optimized", "upscale"), ("optimized", "upscale+enhance")]
        reps = 1 if args.set == "hard" else 2
        print("\n%-30s %8s %8s %10s %10s" % ("配置/预处理", "CER", "EM率", "中位ms", "总ms"))
        for cfg, pre in seq:
            s = run(cfg, pre, repeats=reps, verbose=False, setname=args.set)
            results.append(s)
            print("%-30s %7.2f%% %7.1f%% %9.1f %10.0f" % (
                cfg + "/" + pre, s["cer"] * 100, s["em_rate"] * 100, s["ms_median"], s["ms_total"]))
    elif args.compare:
        for cfg, pre in [("baseline", "none"), ("optimized", "none"),
                         ("optimized", "upscale"), ("optimized", "upscale+enhance")]:
            print("\n>>> 运行 %s / %s" % (cfg, pre))
            s = run(cfg, pre, setname=args.set)
            show(s)
            results.append(s)
    else:
        s = run(args.config, args.preprocess, setname=args.set)
        show(s)
        results.append(s)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print("\n结果已写入:", args.json_out)


if __name__ == "__main__":
    main()
