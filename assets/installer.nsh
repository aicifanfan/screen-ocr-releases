; ============================================================
; 自定义 NSIS 安装脚本（由 electron-builder 的 nsis.include 引入）
;
; 作用：
;   1. 在「选择安装位置」之后插入一页「选择附加任务」
;   2. 提供「创建桌面快捷方式」复选框，默认勾选
;   3. 用户取消勾选时，删除内置流程刚创建的桌面快捷方式
;
; 说明：electron-builder 的辅助安装器（oneClick: false）没有快捷键勾选项，
;       只能通过 createDesktopShortcut 无条件创建，所以这里补一个页面。
;       开始菜单快捷方式保持默认（始终创建），不受此选项影响。
; ============================================================

!ifndef BUILD_UNINSTALLER

  !include "nsDialogs.nsh"
  !include "LogicLib.nsh"
  !include "WinMessages.nsh"

  Var DesktopShortcutCheckbox
  Var DesktopShortcutChoice

  ; 默认勾选（静默安装 /S 时不显示页面，也按勾选处理）
  !macro customInit
    StrCpy $DesktopShortcutChoice "1"
  !macroend

  ; 这里插入 Page 与页面函数：
  ; 此宏由 assistedInstaller.nsh 在 MUI2 之后展开，因此可以使用 MUI_HEADER_TEXT
  !macro customPageAfterChangeDir

    Page custom DesktopShortcutPageShow DesktopShortcutPageLeave

    Function DesktopShortcutPageShow
      ; 覆盖安装（自动更新 / 再次运行安装器）时不打扰用户，保持原有快捷方式状态
      ${If} ${isUpdated}
        Abort
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "选择附加任务" "请选择安装程序要为您执行的附加任务。"

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateCheckBox} 0 0 100% 12u "创建桌面快捷方式(&D)"
      Pop $DesktopShortcutCheckbox
      ${If} $DesktopShortcutChoice == "1"
        ${NSD_SetState} $DesktopShortcutCheckbox ${BST_CHECKED}
      ${Else}
        ${NSD_SetState} $DesktopShortcutCheckbox ${BST_UNCHECKED}
      ${EndIf}

      ${NSD_CreateLabel} 0 22u 100% 34u "在桌面创建「截屏OCR」快捷方式，方便随时启动。$\r$\n取消勾选后，仍可从开始菜单启动本程序。"
      Pop $0

      nsDialogs::Show
    FunctionEnd

    Function DesktopShortcutPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutChoice
    FunctionEnd

  !macroend

  ; 安装文件与快捷方式创建完成后执行：未勾选则删除刚建好的桌面快捷方式
  !macro customInstall
    ${If} $DesktopShortcutChoice != "1"
      Delete "$newDesktopLink"
      ClearErrors
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !macroend

!endif
