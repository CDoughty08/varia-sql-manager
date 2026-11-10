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

; A release staged beside the installation (docs/updates.md) goes with it. The installation's own update helper removes
; it, before the application's files (the helper among them) are removed: it knows which folder that is, takes only one
; that is this user's alone, follows no link planted there, and ends a recovery registered for it. A recursive delete
; from here would do none of that. An installation without the helper never staged anything.
!macro customUnInstall
  IfFileExists "$INSTDIR\resources\updater\Varia.Updater.exe" 0 varia_staging_done
    ExecWait '"$INSTDIR\resources\updater\Varia.Updater.exe" uninstall --install "$INSTDIR"'
    ClearErrors
  varia_staging_done:
!macroend
