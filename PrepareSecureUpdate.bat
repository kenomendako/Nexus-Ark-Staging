@echo off
"%SystemRoot%\System32\chcp.com" 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "%~dp0app\release\PrepareExistingUpdate.ps1" (
    echo [Nexus Ark] 準備ツールが見つかりません。ZIPを新しいフォルダーへすべて展開してください。
    pause
    exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0app\release\PrepareExistingUpdate.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo [Nexus Ark] 準備を完了できませんでした。表示された案内を確認してください。
    pause
)
exit /b %EXIT_CODE%
