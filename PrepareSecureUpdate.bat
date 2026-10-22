@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\app\release\RepairUpdateCertificates.ps1"
if errorlevel 1 (
    echo [Nexus Ark] Repair failed. Do not start the old application yet.
    pause
    exit /b 1
)
echo [Nexus Ark] Repair complete. Return to your original installation and update it normally.
uv --version
pause
