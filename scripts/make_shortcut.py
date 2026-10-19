# -*- coding: utf-8 -*-
"""⚠️ 兼容入口 —— 实际实现已改为 scripts/make_shortcut_win.py（Windows COM）。

历史教训：本文件早期版本按 MS-SHLLINK 规范「手写二进制」创建 .lnk，
但漏写了 LinkTargetIDList（Shell 的绝对目标 ID 列表）。资源管理器能看到图标，
但双击会被 Shell 静默忽略（ShellExecute 返回 WinError 1155「没有应用程序与此
操作的指定文件有关联」），表现为「双击桌面图标完全没反应、程序一次都没启动」。

请勿再用手写二进制方式生成快捷方式，统一走 COM（IShellLinkW + IPersistFile）：
    python scripts/make_shortcut_win.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    print("[提示] 已转调 COM 版实现 make_shortcut_win.py")
    from make_shortcut_win import main
    main()
