# -*- coding: utf-8 -*-
"""创建桌面快捷方式（.lnk），不依赖 COM/PowerShell。

直接按 MS-SHLLINK 规范手写 Shell Link 二进制：
- HasLinkInfo + LocalBasePath（GBK ANSI）定位目标 exe
- StringData（UTF-16）写 RelativePath / WorkingDir / IconLocation
"""
import os
import shutil
import struct
import sys

LNK = r"C:\Users\Lenovo\Desktop\截屏OCR.lnk"
TARGET = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr\截屏OCR.exe"
WORKDIR = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr"
ICON = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr\icon.ico"


def build_link(target, workdir, icon):
    # ---------- ShellLinkHeader (76B) ----------
    header = struct.pack("<I", 76)                                   # HeaderSize
    header += struct.pack("<IHH", 0x00021401, 0, 0)                  # LinkCLSID.Data1-3
    header += bytes.fromhex("c000000000000046")                      # LinkCLSID.Data4
    link_flags = 0x2 | 0x8 | 0x10 | 0x40 | 0x80  # LinkInfo|RelPath|WorkDir|Icon|Unicode
    header += struct.pack("<I", link_flags)
    header += struct.pack("<I", 0x20)                                # FILE_ATTRIBUTE_ARCHIVE
    header += b"\x00" * 8 * 3                                        # 三个时间戳
    header += struct.pack("<I", os.path.getsize(target) & 0xFFFFFFFF)  # FileSize(低32位)
    header += struct.pack("<I", 0)                                   # IconIndex
    header += struct.pack("<I", 1)                                   # SW_SHOWNORMAL
    header += struct.pack("<HH", 0, 0)                               # HotKey, Reserved1
    header += struct.pack("<I", 0) * 1                               # Reserved2
    header += struct.pack("<I", 0)                                   # Reserved3
    assert len(header) == 76, len(header)

    # ---------- LinkInfo ----------
    lbp = target.encode("gbk") + b"\x00"      # LocalBasePath 为 ANSI(ACP=GBK)
    suffix = b"\x00"                          # CommonPathSuffix
    label = b"OS\x00"                         # 卷标占位
    vol = struct.pack("<IIII", 16 + len(label), 3, 0, 16) + label  # FIXED, offset=16
    vol_off = 28
    lbp_off = vol_off + len(vol)
    suffix_off = lbp_off + len(lbp)
    li_size = suffix_off + len(suffix)
    link_info = struct.pack("<IIIII", li_size, 28, 1, vol_off, lbp_off)
    link_info += struct.pack("<II", 0, suffix_off)   # NetRelLink=0, SuffixOffset
    link_info += vol + lbp + suffix
    assert len(link_info) == li_size

    # ---------- StringData (Unicode) ----------
    def ustr(s):
        return struct.pack("<H", len(s)) + s.encode("utf-16-le")

    rel = os.path.basename(target)           # 相对工作目录就是 exe 文件名
    strings = ustr(rel) + ustr(workdir) + ustr(icon)

    return header + link_info + strings


def main():
    for p in (TARGET, ICON):
        if not os.path.exists(p):
            print("[FAIL] 文件不存在:", p)
            sys.exit(1)
    data = build_link(TARGET, WORKDIR, ICON)
    targets = [
        r"C:\Users\Lenovo\Desktop\截屏OCR.lnk",
        r"C:\Users\Lenovo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\截屏OCR.lnk",
    ]
    for lnk in targets:
        # 覆盖前备份旧快捷方式
        if os.path.exists(lnk):
            bak = os.path.join(os.environ.get("TEMP", "."), os.path.basename(lnk) + ".bak")
            shutil.copy2(lnk, bak)
            print("[OK] 旧快捷方式已备份:", bak)
        with open(lnk, "wb") as f:
            f.write(data)
        print("[OK] 已写入:", lnk, f"({len(data)} bytes)")

    # ---------- 自校验：回读确认关键字段 ----------
    for lnk in targets:
        with open(lnk, "rb") as f:
            raw = f.read()
        text16 = raw.decode("utf-16-le", errors="ignore")
        checks = {
            "目标 exe": "screen-ocr" in text16 and TARGET.split("\\")[-1] in text16,
            "工作目录": "screen-ocr" in text16,
            "图标 ico": "icon.ico" in text16,
            "头标志(Unicode)": bool(raw[20] & 0x80),
        }
        for k, v in checks.items():
            print(f"[{'PASS' if v else 'FAIL'}] {os.path.basename(lnk)}: {k}")
        if not all(checks.values()):
            sys.exit(1)
    print("[PASS] 快捷方式创建并验证成功")


if __name__ == "__main__":
    main()
