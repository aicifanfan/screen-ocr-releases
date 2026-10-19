# -*- coding: utf-8 -*-
# M5 验证：打包版 ocr_server.exe 独立运行（与 test_ocr.py 同源图片，同源对比）
import subprocess, json, base64, io, os, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(HERE, 'python', 'ocr_pkg', 'ocr_server', 'ocr_server.exe')


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


def main():
    print('[..] 启动打包版 ocr_server.exe（模型加载约 10~20s）...', flush=True)
    b64 = make_image()
    proc = subprocess.Popen([EXE], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    ready = proc.stdout.readline().decode('utf-8', 'ignore').strip()
    print('ready:', ready, flush=True)

    proc.stdin.write((json.dumps({'type': 'recognize', 'image': b64, 'seq': 2}, ensure_ascii=False) + '\n').encode('utf-8'))
    proc.stdin.flush()
    resp = proc.stdout.readline().decode('utf-8', 'ignore').strip()
    print('result:', resp, flush=True)

    proc.stdin.write(b'{"type":"exit"}\n')
    proc.stdin.flush()
    try:
        proc.stdin.close()
    except Exception:
        pass
    err = proc.stderr.read().decode('utf-8', 'ignore')
    try:
        code = proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        code = 'TIMEOUT'
    print('退出码:', code, flush=True)
    if err.strip():
        print('stderr(前500字):', err[:500], flush=True)

    try:
        data = json.loads(resp)
    except Exception:
        print('FAIL: result 不是合法 JSON')
        sys.exit(1)

    if data.get('type') != 'result':
        print('FAIL: 未返回 result')
        sys.exit(1)

    texts = data.get('texts', [])
    joined = ''.join(texts)
    print('识别文本列表:', texts, flush=True)

    ok = ('你' in joined and '世' in joined) and ('Hello' in joined or '123' in joined)
    print('[PASS] 打包版 exe 识别正确' if ok else '[FAIL] 识别缺失', flush=True)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
