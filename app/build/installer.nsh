; Custom NSIS include, picked up by electron-builder from the build resources folder.

; Keep the taskbar pin when Hangar is installed again over itself.
;
; electron-builder turns its keep-shortcuts path off whenever the folder may be changed, unless the
; installer was started with --updated (only the in-app updater passes it). Without it the old
; uninstaller runs WinShell::UninstShortcut / UninstAppUserModelId and deletes the Start entry,
; which unpins Hangar from the taskbar on every installer run.
;
; The folder page reads this define when the pages are declared, before this macro is inserted, so
; dropping it here keeps the page and only restores the default keep logic: the shortcuts are kept
; when the chosen folder already holds Hangar.exe, and made anew when it is a different folder.
!macro customHeader
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
  !endif
!macroend
