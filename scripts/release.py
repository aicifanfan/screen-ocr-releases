# -*- coding: utf-8 -*-
"""一键发布到 GitHub Releases（自动更新源）。

用法：
    python scripts/release.py            # 用 package.json 当前版本号发布
    python scripts/release.py 0.1.1      # 先把版本号改为 0.1.1 再发布

发布前需把 GitHub token 写入本地文件（不进 git）：
    ~/.workbuddy/screen-ocr-gh-token
"""
import os
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = Path.home() / '.workbuddy' / 'screen-ocr-gh-token'


def main():
    if not TOKEN_FILE.exists():
        print('未找到 token 文件：', TOKEN_FILE)
        print('请把 GitHub token 写入该文件（注意不要提交到 git）')
        sys.exit(1)

    token = TOKEN_FILE.read_text(encoding='utf-8').strip()
    if not token:
        print('token 文件为空，请先写入 GitHub token')
        sys.exit(1)

    # 可选：更新版本号
    if len(sys.argv) > 1:
        new_ver = sys.argv[1]
        pkg_path = ROOT / 'package.json'
        pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
        pkg['version'] = new_ver
        pkg_path.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print('[release] 版本号已更新为', new_ver)

    env = dict(os.environ)
    env['GH_TOKEN'] = token

    # 打包并上传到 GitHub Releases（--publish always 强制发布）
    # shell=True：Windows 下 npx/npm 是 .cmd，需经 shell 解析
    cmd = 'npx electron-builder --publish always'
    print('[release] 执行：', cmd)
    r = subprocess.run(cmd, cwd=str(ROOT), env=env, shell=True)
    sys.exit(r.returncode)


if __name__ == '__main__':
    main()
