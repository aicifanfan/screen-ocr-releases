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
#   6) accurate 档支持「级联识别」（cascade，默认关闭）：先用 small 识别全部行，只有置信度低的行
#      再用 medium 重跑。实测 small 的错误是高置信的（0.90 阈值几乎不触发重跑），
#      CER 只从 4.62% 降到 4.62%，所以默认关闭，保留为实验开关（SCREEN_OCR_CASCADE=1）。
#   7) accurate 档默认走「两段式渐进」（progressive）：先用 small 全量出一版**临时结果**立即返回，
#      再用 medium 对全部行重跑并推送最终结果。用户 0.5~1s 就能看到文字，最终精度与纯 medium 相同
#      （因为最终结果就是 medium 算的）。SCREEN_OCR_PROGRESSIVE=0 可退回「一次算完再返回」。
PROFILES = ("fast", "balanced", "accurate")

# 允许环境变量覆盖，便于同机 A/B 与出问题回退（不设即用下面的默认值）
ENV_THREADS = "SCREEN_OCR_THREADS"
ENV_DET_TYPE = "SCREEN_OCR_DET_TYPE"
ENV_REC_TYPE = "SCREEN_OCR_REC_TYPE"
ENV_CASCADE = "SCREEN_OCR_CASCADE"
ENV_CASCADE_THRESH = "SCREEN_OCR_CASCADE_THRESH"
ENV_CASCADE_MAXRATIO = "SCREEN_OCR_CASCADE_MAXRATIO"
ENV_PROGRESSIVE = "SCREEN_OCR_PROGRESSIVE"

DEFAULT_CASCADE_THRESH = 0.90   # 低于此分数的行用 medium 重跑
DEFAULT_CASCADE_MAXRATIO = 0.5  # 最多重跑一半的行（超过说明整图都不可信，重跑不划算）


def _cascade_on(profile):
    if profile != "accurate":
        return False
    return (os.environ.get(ENV_CASCADE) or "0").strip() not in ("0", "false", "off", "")


def _progressive_on(profile):
    """两段式渐进：只对 accurate 生效；与 cascade 互斥（cascade 是实验开关）。"""
    if profile != "accurate" or _cascade_on(profile):
        return False
    return (os.environ.get(ENV_PROGRESSIVE) or "1").strip() not in ("0", "false", "off")


def _cascade_thresh():
    try:
        return float(os.environ.get(ENV_CASCADE_THRESH) or DEFAULT_CASCADE_THRESH)
    except (TypeError, ValueError):
        return DEFAULT_CASCADE_THRESH


def _cascade_maxratio():
    try:
        v = float(os.environ.get(ENV_CASCADE_MAXRATIO) or DEFAULT_CASCADE_MAXRATIO)
    except (TypeError, ValueError):
        v = DEFAULT_CASCADE_MAXRATIO
    return min(max(v, 0.1), 1.0)


def _clamp_threads(v):
    """线程数夹紧到「至少 1、至多 cpu-2」：侧车与 Electron 抢 CPU 时 UI 更容易卡。"""
    cpu = os.cpu_count() or 4
    return max(1, min(int(v), max(1, cpu - 2), 32))


def _threads():
    """全局推理线程数：默认「留 2 核给 UI/系统，上限 16」，可用 SCREEN_OCR_THREADS 覆盖。

    为什么不是 -1（让 ORT 自己决定）：-1 会按物理核开线程，小图上线程调度开销反而变大；
    为什么上限从 24 降到 16：实测（1707×1067 真实屏幕，48 个识别框）
        det  small  8→781ms  16→588ms  24→936ms  32→1084ms
        rec  small  8→678ms  12→595ms  16→766ms  24→1782ms 32→3385ms
        rec  medium 12→740ms 16→598ms  24→679ms  32→732ms
    线程开过头的代价是「线程同步开销 > 并行收益」，24 线程下 small rec 慢了 3 倍。
    16 是三者都不差的值；真正的甜点用 _apply_module_threads 按模块分别设。
    """
    raw = (os.environ.get(ENV_THREADS) or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return _clamp_threads(int(raw))
    return _clamp_threads(16)


# 各模块的线程甜点（实测见 _threads 注释）。det 与小模型的张量小，线程多了纯亏。
# medium 的张量大：12→740ms、16→598ms、24→679ms，交错 A/B 端到端也一致（16 线程 8.8–9.0s vs 24 线程 9.9–10.0s）。
DEFAULT_THREADS_DET = 16
DEFAULT_THREADS_REC_SMALL = 12
DEFAULT_THREADS_REC_MEDIUM = 16


def _module_threads(env_key, default):
    """按模块读线程数：环境变量优先，未设置用默认值，并夹紧到安全范围。"""
    raw = (os.environ.get(env_key) or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return _clamp_threads(int(raw))
    return _clamp_threads(default)


def _threads_det():
    return _module_threads("SCREEN_OCR_THREADS_DET", DEFAULT_THREADS_DET)


def _threads_rec_small():
    return _module_threads("SCREEN_OCR_THREADS_REC", DEFAULT_THREADS_REC_SMALL)


def _threads_rec_medium():
    return _module_threads("SCREEN_OCR_THREADS_MEDIUM", DEFAULT_THREADS_REC_MEDIUM)


def _rec_kind(profile):
    if profile == "fast":
        return "tiny"
    if profile == "accurate":
        # 渐进/级联模式下主引擎先跑 small，非渐进时直接是 medium
        return "small" if (_progressive_on(profile) or _cascade_on(profile)) else "medium"
    return "small"


def _apply_module_threads(engine, det_thr=None, rec_thr=None):
    """给 det / rec 各自的 ORT 会话设不同线程数。

    rapidocr 的 EngineConfig 是全局的：Det.engine_cfg 与 Rec.engine_cfg 指向同一份 dict。
    session 只在「懒加载」时读一次线程数，所以顺序是「先按 det 的线程数建 det 会话，
    再改成 rec 的线程数建 rec 会话」，建好之后互不影响。
    任何异常都静默退回全局线程数（行为与旧版一致），不让这个优化影响可用性。
    """
    try:
        ort_cfg = engine.cfg.EngineConfig["onnxruntime"]
        original = ort_cfg.get("intra_op_num_threads", _threads())
        if det_thr:
            ort_cfg["intra_op_num_threads"] = _clamp_threads(det_thr)
            engine._load_det_model()
        if rec_thr:
            ort_cfg["intra_op_num_threads"] = _clamp_threads(rec_thr)
            engine._load_rec_model()
        ort_cfg["intra_op_num_threads"] = original
        return True
    except Exception:  # noqa: BLE001
        return False


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
            # 渐进模式下主引擎先用 small 全量出一版临时结果，低延迟；最终结果由 medium 单独重跑
            "Rec.model_type": _model_type(
                "small" if (_cascade_on(profile) or _progressive_on(profile)) else "medium"),
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
    texts, boxes, scores, quads = [], [], [], []

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
                quads.append(quad)
            else:
                boxes.append([0.0, 0.0, 0.0, 0.0])
                quads.append(None)
            scores.append(float(raw_scores[idx]) if idx < len(raw_scores) else 1.0)
        return texts, boxes, scores, quads

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
                else:
                    boxes.append([0.0, 0.0, 0.0, 0.0])
                quads.append(None)
                scores.append(float(item[2]) if len(item) >= 3 and item[2] is not None else 1.0)
    return texts, boxes, scores, quads


def recompute_lines(arr, texts, scores, quads, precise_rec, indices):
    """用更准的 rec 重跑指定行，就地写回 texts/scores。

    返回 (成功替换行数, 耗时毫秒)。任何异常都退化为「保持原结果」，不影响可用性。
    """
    indices = [i for i in indices if 0 <= i < len(texts) and quads[i] is not None]
    if not indices:
        return 0, 0.0

    try:
        from rapidocr.utils.process_img import get_rotate_crop_image
        from rapidocr.ch_ppocr_rec.typings import TextRecInput

        t0 = time.perf_counter()
        crops, used_idx = [], []
        for i in indices:
            crop = get_rotate_crop_image(arr, np.array(quads[i], dtype=np.float32))
            if crop is None or crop.size == 0:
                continue
            crops.append(crop)
            used_idx.append(i)
        if not crops:
            return 0, 0.0

        out = precise_rec(TextRecInput(img=crops))
        new_txts = list(getattr(out, "txts", []) or [])
        new_scores = list(getattr(out, "scores", []) or [])
        n = 0
        for k, i in enumerate(used_idx[:len(new_txts)]):
            t = str(new_txts[k] or "").strip()
            if not t:
                continue  # 重跑出空串：宁可保留原结果
            texts[i] = new_txts[k]
            if k < len(new_scores):
                scores[i] = float(new_scores[k])
            n += 1
        return n, round((time.perf_counter() - t0) * 1000, 1)
    except Exception:  # noqa: BLE001
        return 0, 0.0


def refine_low_confidence(arr, texts, scores, quads, precise_rec):
    """级联识别第二步：只把置信度低的行用 medium 重跑。"""
    if not texts:
        return 0, 0.0
    thresh = _cascade_thresh()
    max_n = max(1, int(round(len(texts) * _cascade_maxratio())))
    low = [i for i, s in enumerate(scores) if s < thresh][:max_n]
    return recompute_lines(arr, texts, scores, quads, precise_rec, low)


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
            eng = RapidOCR(params=build_params(p))
            # 按模块设线程：det 与小模型 rec 用更少的线程（实测 small rec 在 24 线程下慢 3 倍）
            _apply_module_threads(eng, _threads_det(),
                                  _threads_rec_small() if _rec_kind(p) != "medium" else _threads_rec_medium())
            return eng, p
        except Exception as exc:  # noqa: BLE001
            # 例如 accurate 档的 medium 模型未随包分发且当前无网络下载 → 回退 balanced
            if p != "balanced":
                _emit({"type": "warn", "message": "档位 %s 不可用(%s)，已回退 balanced" % (p, exc)})
                eng = RapidOCR(params=build_params("balanced"))
                _apply_module_threads(eng, _threads_det(), _threads_rec_small())
                return eng, "balanced"
            raise

    t0 = time.perf_counter()
    engine, profile = new_engine(profile)

    # 级联/渐进模式下的「精修」识别器（只在 accurate 时才真正加载 medium rec）
    precise = {"engine": None}

    def get_precise():
        if precise["engine"] is None:
            params = build_params("accurate")
            params["Rec.model_type"] = _model_type("medium")
            holder = RapidOCR(params=params)
            # medium 需要更多线程：单独建会话，走 THREADS_REC_MEDIUM
            _apply_module_threads(holder, None, _threads_rec_medium())
            precise["engine"] = holder._load_rec_model()
        return precise["engine"]

    init_ms = (time.perf_counter() - t0) * 1000
    warm_ms = warmup(engine)
    if _progressive_on(profile):
        try:
            get_precise()  # 预热 medium rec，避免第一次截图多等 1s
        except Exception:  # noqa: BLE001
            pass
    _emit({"type": "ready", "profile": profile, "init_ms": round(init_ms, 1),
           "warmup_ms": warm_ms, "threads": _threads(), "threads_det": _threads_det(),
           "threads_rec": _threads_rec_small() if _rec_kind(profile) != "medium" else _threads_rec_medium(),
           "cascade": _cascade_on(profile), "progressive": _progressive_on(profile)})

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
                precise["engine"] = None  # 档位变了，精修识别器要重建
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
                texts, boxes, scores, quads = parse_output(res)
                progressive = _progressive_on(profile)

                # 级联（实验开关）：低置信行用 medium 重跑，然后一次性返回
                reran, refine_ms = 0, 0.0
                if _cascade_on(profile):
                    reran, refine_ms = refine_low_confidence(arr, texts, scores, quads, get_precise())

                # 识别结果符号规范化（星号变体/全角标点 → 半角 + 中文间空格清理）
                texts = [postprocess_text(t) for t in texts]

                # 两段式：先把 small 的结果作为临时结果立刻返回（stage=provisional），
                # 再去算最终结果并用 refined 消息推送过来。
                _emit({
                    "type": "result",
                    "seq": seq,
                    "texts": texts,
                    "boxes": boxes,
                    "scores": scores,
                    "profile": profile,
                    "stage": "provisional" if progressive else "final",
                    "cascade": {"reran": reran, "refine_ms": refine_ms} if _cascade_on(profile) else None,
                    "elapse_ms": round((time.perf_counter() - t_start) * 1000, 1),
                })

                if progressive:
                    final_texts = list(texts)
                    final_scores = list(scores)
                    refined_n, refined_ms = 0, 0.0
                    if quads and final_texts:
                        refined_n, refined_ms = recompute_lines(
                            arr, final_texts, final_scores, quads, get_precise(),
                            range(len(final_texts)))
                        final_texts = [postprocess_text(t) for t in final_texts]
                    _emit({
                        "type": "refined",
                        "seq": seq,
                        "texts": final_texts,
                        "scores": final_scores,
                        "profile": profile,
                        "refined": refined_n > 0,
                        "lines": len(final_texts),
                        "refine_ms": refined_ms,
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
