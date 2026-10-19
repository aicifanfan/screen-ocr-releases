#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OCR 识别服务（sidecar 子进程）

通过 stdin/stdout 与 Electron 主进程通信，每行一个 JSON：
  输入 {"type": "recognize", "image": "<base64>", "seq": 1}
  输出 {"type": "result", "seq": 1, "texts": [...], "boxes": [...], "scores": [...]}
  出错 {"type": "error",  "seq": 1, "message": "..."}

启动完成后先输出 {"type": "ready"} 告知主进程模型已就绪。

编码说明：所有 JSON 用 ensure_ascii=True 输出（中文转 \\uXXXX），
避免 Windows 下 stdout 默认 GBK 编码导致的中文乱码（PyInstaller 打包后尤甚）。
"""
import sys
import json
import base64
import io
import os
import re
import time

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

# 尽量把 stdout/stderr 设为 UTF-8（ensure_ascii=True 下实际输出纯 ASCII，此为双保险）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 识别档位
# 性能结论（见 python/bench_ocr.py，退化样本集实测）：
#   baseline(rapidocr 默认)  CER 9.09%  1335ms/图
#   balanced(本默认)         CER 2.16%   142ms/图   ← 速度 9.4x、错误率降到 1/4
#   fast(tiny)               CER 3.46%    46ms/图
#   accurate(medium)         CER 0.72%  1887ms/图   ← 精度最高但慢
#
# 关键改动：
#   1) Det.limit_type 由 min 改 max —— 默认值会把「短边强制放大到 736」，
#      截屏选区通常只有几十像素高，会被放大十几倍：既慢，又把模糊噪声一起放大，准确率反而更差。
#   2) use_cls=False —— 截图文字基本水平，跳过 180° 方向分类。
#   3) intra_op 线程数按核数自适应（见 _threads），旧版硬编码 min(8, cpu)
#      在 32 核机器上只用 1/4 算力，实测并行效率 97%，放开近似线性收益。
#   4) rec_batch_num 6→12 —— 减少小图块的调度开销。
#   5) accurate 档 det 改用 small：检测只决定「框在哪、几行」，文字仍由 medium rec 识别；
#      det medium 在 960 封顶下固定吃 2.7s，换 small 只要 0.5s，精度几乎无损（见 docs/优化方向筛选与推进建议.md）。
PROFILES = ("fast", "balanced", "accurate")

# 允许环境变量覆盖，便于同机 A/B 与出问题回退（不设即用下面的默认值）
ENV_THREADS = "SCREEN_OCR_THREADS"
ENV_DET_TYPE = "SCREEN_OCR_DET_TYPE"
ENV_REC_TYPE = "SCREEN_OCR_REC_TYPE"


def _threads():
    """推理线程数：默认「留 2 核给 UI/系统，上限 24」，可用 SCREEN_OCR_THREADS 覆盖。

    为什么不是 -1（让 ORT 自己决定）：-1 会按物理核开线程，小图上线程调度开销反而变大；
    为什么留 2 核：侧车与 Electron 主进程/渲染进程抢 CPU 时，UI 更容易卡。
    """
    raw = (os.environ.get(ENV_THREADS) or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return max(1, min(int(raw), 64))
    cpu = os.cpu_count() or 4
    return max(2, min(cpu - 2, 24))


def _model_type(name):
    """取 ModelType 枚举（不同 rapidocr 版本可能没有该枚举，降级为字符串）"""
    try:
        from rapidocr.utils.typings import ModelType
        return getattr(ModelType, name.upper())
    except Exception:  # noqa: BLE001
        return name


def build_params(profile):
    threads = _threads()
    params = {
        "Global.use_cls": False,          # 跳过方向分类
        "Global.text_score": 0.45,        # 略降阈值，减少小字漏检
        "Det.limit_side_len": 960,        # 只限制大图，不放大原图
        "Det.limit_type": "max",
        "Rec.rec_batch_num": 12,
        "EngineConfig.onnxruntime.intra_op_num_threads": threads,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    }
    if profile == "fast":
        params.update({
            "Det.limit_side_len": 736,
            "Det.model_type": _model_type("tiny"),
            "Rec.model_type": _model_type("tiny"),
        })
    elif profile == "accurate":
        params.update({
            "Det.model_type": _model_type("small"),
            "Rec.model_type": _model_type("medium"),
        })

    # 环境变量可覆盖任意档位的模型选择，用于同机 A/B（生产默认值不受影响）
    for env_key, param_key in ((ENV_DET_TYPE, "Det.model_type"), (ENV_REC_TYPE, "Rec.model_type")):
        val = (os.environ.get(env_key) or "").strip().lower()
        if val in ("tiny", "small", "medium"):
            params[param_key] = _model_type(val)
    return params


def warmup(engine):
    """预热：跑一次检测 + 一次识别，把 ORT 的图优化与内存分配挪到启动阶段。

    只做一次很小的推理（白底图，识别结果为空是正常的），目的是让「第一次截图」不再额外多等。
    失败不影响主流程：预热只是优化，不是功能依赖。
    """
    t0 = time.perf_counter()
    try:
        # rapidocr 的模型是懒加载，构造 RapidOCR() 并不会建立 ORT session；
        # 这里显式触发一次 det/rec 的前向，把 session 初始化与内存分配挪到启动阶段。
        from rapidocr.ch_ppocr_rec.typings import TextRecInput
        blank = np.full((64, 320, 3), 255, dtype=np.uint8)
        det = engine._load_det_model()
        rec = engine._load_rec_model()
        det(blank)
        rec(TextRecInput(img=blank[8:56, 16:304]))
    except Exception:  # noqa: BLE001
        return None
    return round((time.perf_counter() - t0) * 1000, 1)


def parse_output(res):
    """兼容 rapidocr 返回结构，统一提取 texts / boxes(矩形[x1,y1,x2,y2]) / scores。

    rapidocr 3.x 返回 RapidOCROutput：txts 为 tuple，boxes 为 numpy.ndarray
    形状 (n,4,2)（4 个角点的四边形），scores 为 tuple。这里统一转成可
    JSON 序列化的纯 Python 类型，并把四边形归约为外接矩形。
    """
    texts, boxes, scores = [], [], []

    # 3.x / 2.x 返回 RapidOCROutput 对象（含 .txts / .boxes / .scores）
    if hasattr(res, "txts"):
        raw_txts = list(res.txts or [])
        raw_boxes = res.boxes
        raw_scores = getattr(res, "scores", None)

        if raw_boxes is not None:
            raw_boxes = raw_boxes.tolist() if isinstance(raw_boxes, np.ndarray) else list(raw_boxes)
        else:
            raw_boxes = []
        raw_scores = list(raw_scores) if raw_scores is not None else []

        # 过滤空文本（并保持 boxes/scores 一一对应）
        for idx, t in enumerate(raw_txts):
            if t is None:
                continue
            s = str(t)
            if not s.strip():
                continue
            texts.append(s)
            if idx < len(raw_boxes):
                quad = raw_boxes[idx]
                xs = [float(p[0]) for p in quad]
                ys = [float(p[1]) for p in quad]
                boxes.append([min(xs), min(ys), max(xs), max(ys)])
            else:
                boxes.append([0.0, 0.0, 0.0, 0.0])
            scores.append(float(raw_scores[idx]) if idx < len(raw_scores) else 1.0)
        return texts, boxes, scores

    # 1.x 返回 (result, elapse) 元组
    if isinstance(res, (list, tuple)) and len(res) == 2 and isinstance(res[1], (list, tuple, float, int)):
        res = res[0]

    # result 为 [box, text, score] 的列表
    if isinstance(res, (list, tuple)):
        for item in res:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                texts.append(str(item[1]))
                if len(item) >= 3 and isinstance(item[0], (list, tuple)):
                    boxes.append([float(v) for v in item[0]])
                scores.append(float(item[2]) if len(item) >= 3 and item[2] is not None else 1.0)
    return texts, boxes, scores


# —— 符号规范化（保守）：只做确定性替换，不误伤 ×、x 等真实字符 ——
# 各种 Unicode 星号变体 → 半角 *
STAR_VARIANTS = "\uFF0A\u2217\u2731\u204E\u22C6\uFE61"
# 全角标点/符号 → 半角
FULLWIDTH_MAP = {
    "\uFF08": "(", "\uFF09": ")", "\uFF1A": ":", "\uFF1B": ";",
    "\uFF0C": ",", "\uFF01": "!", "\uFF1F": "?", "\uFF02": '"',
    "\uFF03": "#", "\uFF20": "@", "\uFF06": "&", "\uFF05": "%", "\uFF04": "$",
}


def postprocess_text(text):
    """保守的符号规范化：星号变体 → *，全角标点/符号 → 半角，并清理中文间多余空格。

    仅处理「本质上就是该符号」的 Unicode 变体（如全角＊、数学星号 ∗），
    不做启发式推断（不把 ×/x 强行改回 *），避免误伤乘号等真实字符。
    """
    if not text:
        return text
    for ch in STAR_VARIANTS:
        text = text.replace(ch, "*")
    for k, v in FULLWIDTH_MAP.items():
        text = text.replace(k, v)
    return clean_cjk_spaces(text)


# 中文标点（含全角符号区）
_CJK = "\u4e00-\u9fa5"
_CJK_PUNCT = "\u3000-\u303f\uff00-\uffef"


def clean_cjk_spaces(text):
    """清理 OCR 在中文之间误插的空格（中文无需词间空格，粘贴时尤其碍事）。

    只处理「纯中文/中文标点」之间的空白：
      - 中文 与 中文 之间的空格 → 删除
      - 中文 与 中文标点 之间的空格 → 删除
      - 中文 与 英文/数字 之间的空格 → 保留（可读性需要）
    """
    if not text:
        return text
    # 中文 ↔ 中文
    text = re.sub(r"(?<=[" + _CJK + r"])\s+(?=[" + _CJK + r"])", "", text)
    # 中文 ↔ 中文标点
    text = re.sub(r"(?<=[" + _CJK + r"])\s+(?=[" + _CJK_PUNCT + r"])", "", text)
    text = re.sub(r"(?<=[" + _CJK_PUNCT + r"])\s+(?=[" + _CJK + r"])", "", text)
    # 连续的内部空白压缩为一个（不处理首尾，避免破坏排版）
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text


def _emit(obj):
    """输出一行 JSON（ensure_ascii=True，中文转 \\uXXXX，规避编码问题）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    profile = (os.environ.get("SCREEN_OCR_PROFILE") or "balanced").strip().lower()
    if profile not in PROFILES:
        profile = "balanced"

    def new_engine(p):
        try:
            return RapidOCR(params=build_params(p)), p
        except Exception as exc:  # noqa: BLE001
            # 例如 accurate 档的 medium 模型未随包分发且当前无网络下载 → 回退 balanced
            if p != "balanced":
                _emit({"type": "warn", "message": "档位 %s 不可用(%s)，已回退 balanced" % (p, exc)})
                return RapidOCR(params=build_params("balanced")), "balanced"
            raise

    t0 = time.perf_counter()
    engine, profile = new_engine(profile)
    init_ms = (time.perf_counter() - t0) * 1000
    warm_ms = warmup(engine)
    _emit({"type": "ready", "profile": profile, "init_ms": round(init_ms, 1),
           "warmup_ms": warm_ms, "threads": _threads()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        seq = req.get("seq")
        kind = req.get("type")

        # 运行时切换档位（设置页改精度后即时生效，无需重启）
        if kind == "setProfile":
            p = str(req.get("profile") or "").strip().lower()
            if p in PROFILES and p != profile:
                t0 = time.perf_counter()
                engine, profile = new_engine(p)
                warmup(engine)  # 切档后立刻预热，避免「切换后第一次识别」特别慢
                _emit({"type": "profileChanged", "seq": seq, "profile": profile,
                       "init_ms": round((time.perf_counter() - t0) * 1000, 1)})
            else:
                _emit({"type": "profileChanged", "seq": seq, "profile": profile, "init_ms": 0})
            continue

        if kind == "recognize":
            try:
                t_start = time.perf_counter()
                raw = base64.b64decode(req["image"])
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                arr = np.array(img)
                res = engine(arr)
                texts, boxes, scores = parse_output(res)
                # 识别结果符号规范化（星号变体/全角标点 → 半角 + 中文间空格清理）
                texts = [postprocess_text(t) for t in texts]
                _emit({
                    "type": "result",
                    "seq": seq,
                    "texts": texts,
                    "boxes": boxes,
                    "scores": scores,
                    "profile": profile,
                    "elapse_ms": round((time.perf_counter() - t_start) * 1000, 1),
                })
            except Exception as exc:  # noqa: BLE001
                _emit({"type": "error", "seq": seq, "message": str(exc)})

        elif kind == "ping":
            _emit({"type": "pong", "seq": seq})

        elif kind == "exit":
            break


if __name__ == "__main__":
    main()
