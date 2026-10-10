; Hooks for Tauri's NSIS installer. Before files are replaced or removed, a running DevDock is
; asked to quit the way its tray's Quit does, so it stops its scripts first. The installer's own
; check afterwards closes the app by force only if it is still running after 30 seconds.

!macro DEVDOCK_QUIT_RUNNING_APP
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; A second launch with --quit hands the request to the running app and exits; with no app
    ; running it exits at once.
    nsExec::Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
    Pop $0
    ; A running executable cannot be opened for writing, so this waits until DevDock has exited.
    StrCpy $1 0
    ${Do}
      ClearErrors
      FileOpen $0 "$INSTDIR\${MAINBINARYNAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $0
        ${Break}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 60
        ${Break}
      ${EndIf}
      Sleep 500
    ${Loop}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro DEVDOCK_QUIT_RUNNING_APP
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DEVDOCK_QUIT_RUNNING_APP
!macroend
