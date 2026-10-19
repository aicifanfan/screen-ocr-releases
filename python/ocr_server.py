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

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

# 尽量把 stdout/stderr 设为 UTF-8（ensure_ascii=True 下实际输出纯 ASCII，此为双保险）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def parse_output(res):
    """兼容 rapidocr 返回结构，统一提取 texts / boxes(矩形[x1,y1,x2,y2]) / scores。

    rapidocr 3.x 返回 RapidOCROutput：txts 为 tuple，boxes 为 numpy.ndarray
    形状 (n,4,2)（4 个角点的四边形），scores 为 tuple。这里统一转成可
    JSON 序列化的纯 Python 类型，并把四边形归约为外接矩形。
    """
    texts, boxes, scores = [], [], []

    # 3.x / 2.x 返回 RapidOCROutput 对象（含 .txts / .boxes / .scores）
    if hasattr(res, "txts"):
        texts = [str(t) for t in res.txts]

        if hasattr(res, "boxes") and res.boxes is not None:
            raw = res.boxes.tolist() if isinstance(res.boxes, np.ndarray) else list(res.boxes)
            for quad in raw:
                # quad：4 个角点 [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
                xs = [float(p[0]) for p in quad]
                ys = [float(p[1]) for p in quad]
                boxes.append([min(xs), min(ys), max(xs), max(ys)])

        if hasattr(res, "scores") and res.scores is not None:
            scores = [float(s) for s in res.scores]
        else:
            scores = [1.0] * len(texts)
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
    """保守的符号规范化：星号变体 → *，全角标点/符号 → 半角。

    仅处理「本质上就是该符号」的 Unicode 变体（如全角＊、数学星号 ∗），
    不做启发式推断（不把 ×/x 强行改回 *），避免误伤乘号等真实字符。
    """
    if not text:
        return text
    for ch in STAR_VARIANTS:
        text = text.replace(ch, "*")
    for k, v in FULLWIDTH_MAP.items():
        text = text.replace(k, v)
    return text


def _emit(obj):
    """输出一行 JSON（ensure_ascii=True，中文转 \\uXXXX，规避编码问题）"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    engine = RapidOCR()
    _emit({"type": "ready"})

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

        if kind == "recognize":
            try:
                raw = base64.b64decode(req["image"])
                img = Image.open(io.BytesIO(raw)).convert("RGB")
                arr = np.array(img)
                res = engine(arr)
                texts, boxes, scores = parse_output(res)
                # 识别结果符号规范化（星号变体/全角标点 → 半角）
                texts = [postprocess_text(t) for t in texts]
                _emit({
                    "type": "result",
                    "seq": seq,
                    "texts": texts,
                    "boxes": boxes,
                    "scores": scores,
                })
            except Exception as exc:  # noqa: BLE001
                _emit({"type": "error", "seq": seq, "message": str(exc)})

        elif kind == "ping":
            _emit({"type": "pong", "seq": seq})

        elif kind == "exit":
            break


if __name__ == "__main__":
    main()
