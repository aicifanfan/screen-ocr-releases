# -*- coding: utf-8 -*-
"""用 Windows 官方 COM（IShellLinkW + IPersistFile）创建快捷方式。

为什么不用手写 MS-SHLLINK 二进制：
手写时若缺少 LinkTargetIDList（Shell 绝对目标 ID 列表），资源管理器能显示图标，
但双击会静默失败（ShellExecute 返回 WinError 1155 没有关联），程序根本不启动。
COM 方式由系统生成完整结构，行为与手动创建快捷方式一致。
"""
import ctypes
import os
import sys
import uuid
from ctypes import POINTER, byref, c_int, c_void_p, c_ulong, wintypes

ole32 = ctypes.oledll.ole32
shell32 = ctypes.oledll.shell32


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def make_guid(s):
    return GUID.from_buffer_copy(uuid.UUID(s).bytes_le)


CLSID_ShellLink = make_guid("00021401-0000-0000-C000-000000000046")
IID_IShellLinkW = make_guid("000214F9-0000-0000-C000-000000000046")
IID_IPersistFile = make_guid("0000010b-0000-0000-C000-000000000046")

CLSCTX_INPROC_SERVER = 1
SW_SHOWNORMAL = 1


def vfunc(ptr, index, restype, *argtypes):
    vtbl = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
    proto = ctypes.WINFUNCTYPE(restype, c_void_p, *argtypes)
    return proto(vtbl[index])


def check(hr, what):
    if hr < 0:
        raise OSError("COM 调用失败 %s hr=0x%08X" % (what, hr & 0xFFFFFFFF))


def create_shortcut(lnk_path, target, workdir=None, icon=None, desc=None):
    ole32.CoInitialize(None)
    try:
        p_sl = c_void_p()
        check(
            ole32.CoCreateInstance(
                byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
                byref(IID_IShellLinkW), byref(p_sl)
            ),
            "CoCreateInstance(ShellLink)",
        )

        # IShellLinkW::SetPath(LPCWSTR, DWORD) -> vtable index 20
        vfunc(p_sl, 20, ctypes.HRESULT, wintypes.LPCWSTR, wintypes.DWORD)(p_sl, target, 0)
        # SetDescription -> 7
        if desc:
            vfunc(p_sl, 7, ctypes.HRESULT, wintypes.LPCWSTR)(p_sl, desc)
        # SetWorkingDirectory -> 9
        if workdir:
            vfunc(p_sl, 9, ctypes.HRESULT, wintypes.LPCWSTR)(p_sl, workdir)
        # SetIconLocation(LPCWSTR, int) -> 17
        if icon:
            vfunc(p_sl, 17, ctypes.HRESULT, wintypes.LPCWSTR, c_int)(p_sl, icon, 0)
        # SetShowCmd(int) -> 15
        vfunc(p_sl, 15, ctypes.HRESULT, c_int)(p_sl, SW_SHOWNORMAL)

        # QueryInterface(IID_IPersistFile) -> 0
        p_pf = c_void_p()
        check(
            vfunc(p_sl, 0, ctypes.HRESULT, ctypes.POINTER(GUID), ctypes.POINTER(c_void_p))(
                p_sl, byref(IID_IPersistFile), byref(p_pf)
            ),
            "QueryInterface(IPersistFile)",
        )
        # IPersistFile::Save(LPCWSTR, BOOL) -> index 6
        check(
            vfunc(p_pf, 6, ctypes.HRESULT, wintypes.LPCWSTR, wintypes.BOOL)(p_pf, lnk_path, True),
            "IPersistFile::Save",
        )
        # Release
        vfunc(p_pf, 2, ctypes.HRESULT)(p_pf)
        vfunc(p_sl, 2, ctypes.HRESULT)(p_sl)
    finally:
        ole32.CoUninitialize()


def verify(lnk_path, expected_target):
    """回读：用 IShellLinkW::GetPath 验证目标（不依赖 COM 自动化封装）"""
    ole32.CoInitialize(None)
    try:
        p_sl = c_void_p()
        ole32.CoCreateInstance(
            byref(CLSID_ShellLink), None, CLSCTX_INPROC_SERVER,
            byref(IID_IShellLinkW), byref(p_sl)
        )
        p_pf = c_void_p()
        vfunc(p_sl, 0, ctypes.HRESULT, ctypes.POINTER(GUID), ctypes.POINTER(c_void_p))(
            p_sl, byref(IID_IPersistFile), byref(p_pf)
        )
        # IPersistFile::Load(LPCWSTR, DWORD) -> index 5
        hr = vfunc(p_pf, 5, ctypes.HRESULT, wintypes.LPCWSTR, wintypes.DWORD)(p_pf, lnk_path, 0)
        if hr < 0:
            return None, "Load 失败 hr=0x%08X" % (hr & 0xFFFFFFFF)
        buf = ctypes.create_unicode_buffer(1024)
        # IShellLinkW::GetPath(LPWSTR, int, WIN32_FIND_DATAW*, DWORD) -> index 3
        vfunc(p_sl, 3, ctypes.HRESULT, wintypes.LPWSTR, c_int, c_void_p, wintypes.DWORD)(
            p_sl, buf, 1024, None, 0
        )
        vfunc(p_pf, 2, ctypes.HRESULT)(p_pf)
        vfunc(p_sl, 2, ctypes.HRESULT)(p_sl)
        got = buf.value
        return got, ("OK" if os.path.normcase(got) == os.path.normcase(expected_target) else "目标不一致")
    finally:
        ole32.CoUninitialize()


TARGET = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr\截屏OCR.exe"
WORKDIR = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr"
ICON = r"C:\Users\Lenovo\AppData\Local\Programs\screen-ocr\icon.ico"

TARGETS = [
    r"C:\Users\Lenovo\Desktop\截屏OCR.lnk",
    r"C:\Users\Lenovo\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\截屏OCR.lnk",
]


def main():
    for p in (TARGET, ICON):
        if not os.path.exists(p):
            print("[FAIL] 文件不存在:", p)
            sys.exit(1)

    for lnk in TARGETS:
        try:
            create_shortcut(lnk, TARGET, WORKDIR, ICON, "截屏 OCR - 框选屏幕区域识别文字")
            print("[OK] 已创建:", lnk, "(%d bytes)" % os.path.getsize(lnk))
        except Exception as e:
            print("[FAIL] 创建失败:", lnk, "->", e)
            sys.exit(1)

    ok = True
    for lnk in TARGETS:
        got, status = verify(lnk, TARGET)
        print("[%s] 回读 %s -> %s" % ("PASS" if status == "OK" else "FAIL", os.path.basename(lnk), got))
        if status != "OK":
            ok = False
    if not ok:
        sys.exit(1)
    print("[PASS] 快捷方式创建并验证成功")


if __name__ == "__main__":
    main()
