; Candela installer for Windows (per-user, no administrator rights needed).
; Build after `npm run dist:win` has produced dist/win-unpacked:
;   makensis desktop/installer.nsi
Unicode true
Target amd64-unicode
SetCompressor /SOLID lzma

!define APPNAME "Candela"
!define VERSION "1.0.0"
!define EXE "Candela.exe"
!define APPID "com.candela.charts"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Candela"
!ifndef SRCDIR
  !define SRCDIR "..\dist\win-unpacked"
!endif
!ifndef OUTFILE
  !define OUTFILE "..\dist\Candela-Setup-${VERSION}.exe"
!endif

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user
BrandingText "Candela ${VERSION}"

!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "build\icon.ico"
!define MUI_UNICON "build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This installs Candela, free charting with live crypto and stock data, indicators, custom scripts and alerts.$\r$\n$\r$\nNo administrator rights are needed. Click Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start Candela"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "Candela installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Candela"
VIAddVersionKey "LegalCopyright" "Candela"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Candela needs 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  ; a running Candela (maybe in the tray) locks its files; it saves as it goes, so close it
  nsExec::Exec 'taskkill /F /T /IM "${EXE}"'
  Sleep 800
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources" ; drop files from an older version
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall Candela.exe"

  ; Candela adds its app ID to this shortcut when it starts (Windows needs that for notifications)
  CreateShortcut "$SMPROGRAMS\Candela.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\Candela.lnk" "$INSTDIR\${EXE}"

  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "Candela"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "Candela"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall Candela.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall Candela.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /T /IM "${EXE}"'
  Sleep 800
  Delete "$SMPROGRAMS\Candela.lnk"
  Delete "$DESKTOP\Candela.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\${APPNAME}"
  ; "Start with Windows" entry, if it was turned on
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPID}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APPNAME}"
  ; your charts, alerts, scripts and settings live in %APPDATA%\Candela; keep them unless asked
  IfSilent keep
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Candela data (charts, alerts, scripts and settings)?" IDNO keep
  RMDir /r "$APPDATA\Candela"
  keep:
SectionEnd
