# -*- coding: utf-8 -*-
"""Step 2 单点测试：
1) postprocess_text 符号规范化单元测试（确定性）
2) 生成含中文图片 → 通过 ocr_server.py 识别 → 验证结果（集成）"""
import subprocess
import json
import base64
import io
import sys
import os
import importlib.util

from PIL import Image, ImageDraw, ImageFont

SERVERS = [sys.executable, os.path.join(os.path.dirname(__file__), 'python', 'ocr_server.py')]


def load_postprocess():
    spec = importlib.util.spec_from_file_location(
        'ocr_server', os.path.join(os.path.dirname(__file__), 'python', 'ocr_server.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.postprocess_text


def test_postprocess():
    pp = load_postprocess()
    # 星号变体 → *
    assert pp('＊') == '*', '全角＊未规范'
    assert pp('∗') == '*', '数学星号∗未规范'
    assert pp('a＊b') == 'a*b', '句中星号未规范'
    assert pp('✱⁎⋆') == '***', '其他星号变体未规范'
    # 全角标点/符号 → 半角
    assert pp('（测试）') == '(测试)', '全角括号未规范'
    assert pp('＃＠＆％＄') == '#@&%$', '全角符号未规范'
    assert pp('１２３') == '１２３', '全角数字不应被改（不在映射表）'
    # 不误伤真实字符
    assert pp('3 × 4') == '3 × 4', '×（乘号）不应被误改'
    assert pp('x X') == 'x X', 'x/X 不应被误改'
    # 空/None 安全
    assert pp('') == ''
    assert pp(None) is None
    print('PASS: postprocess_text 符号规范化（星号变体/全角标点/不误伤 ×·x）全部正确')


def find_font():
    candidates = [
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\simhei.ttf',
        r'C:\Windows\Fonts\simsun.ttc',
        r'C:\Windows\Fonts\Deng.ttf',
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def make_image():
    img = Image.new('RGB', (440, 140), 'white')
    draw = ImageDraw.Draw(img)
    fp = find_font()
    font = ImageFont.truetype(fp, 40) if fp else ImageFont.load_default()
    draw.text((20, 25), '你好世界', fill='black', font=font)
    draw.text((20, 80), 'Hello 123', fill='black', font=font)
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return base64.b64encode(buf.getvalue()).decode()


def test_recognize():
    b64 = make_image()
    proc = subprocess.Popen(
        SERVERS, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding='utf-8'
    )
    ready = proc.stdout.readline().strip()
    print('服务状态:', ready)

    proc.stdin.write(json.dumps({'type': 'recognize', 'image': b64, 'seq': 2}, ensure_ascii=False) + '\n')
    proc.stdin.flush()
    resp = proc.stdout.readline().strip()

    proc.stdin.write(json.dumps({'type': 'exit'}) + '\n')
    proc.stdin.flush()
    err = proc.stderr.read()
    if err:
        print('stderr:', err)
    proc.wait(timeout=15)

    data = json.loads(resp)
    if data.get('type') != 'result':
        print('FAIL: 未返回 result')
        sys.exit(1)

    texts = data.get('texts', [])
    joined = ''.join(texts)
    print('识别文本列表:', texts)
    print('拼接:', joined)

    assert '你' in joined and '世' in joined, '中文识别缺失'
    assert 'Hello' in joined or '123' in joined, '英文/数字识别缺失'
    print('PASS: 中文与英文均正确识别')


if __name__ == '__main__':
    test_postprocess()
    test_recognize()
    print('ALL PASS')
