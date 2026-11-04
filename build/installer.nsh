; Keep interactive installs explicit, including when invoked with electron-builder's --updated flag.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

; NSIS already understands /S. Also accept the exact --silent argument before install-mode initialization.
!macro preInit
  !ifndef BUILD_UNINSTALLER
    InitPluginsDir
    ${StdUtils.ParameterCnt} $R0
    StrCpy $R1 0
    varia_check_silent:
      IntCmp $R1 $R0 varia_done_silent varia_read_silent varia_done_silent
    varia_read_silent:
      ${StdUtils.ParameterStr} $R2 $R1
      StrCmp $R2 "--silent" 0 varia_next_silent
        SetSilent silent
        Goto varia_done_silent
    varia_next_silent:
      IntOp $R1 $R1 + 1
      Goto varia_check_silent
    varia_done_silent:
  !endif
!macroend
