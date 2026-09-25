@echo off
chcp 65001 > nul
setlocal
cd /d "%~dp0"

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

where uv >nul 2>nul
if %errorlevel% EQU 0 goto :FOUND_UV
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
set "PATH=%USERPROFILE%\.local\bin;%USERPROFILE%\.cargo\bin;%USERPROFILE%\AppData\Roaming\uv\bin;%PATH%"
where uv >nul 2>nul
if %errorlevel% NEQ 0 goto :UV_INSTALL_FAILED

:FOUND_UV
if not exist "app" goto :MISSING_APP_DIR
if not exist "updater\current\update_host\supervisor.py" goto :MISSING_UPDATE_HOST
set "PYTHONPATH=%CD%\updater\current"
uv run --no-project --python 3.12 python -m update_host.supervisor --root "%CD%"
set EXIT_CODE=%errorlevel%
if %EXIT_CODE% EQU 123 goto :FOUND_UV
if %EXIT_CODE% NEQ 0 goto :APP_CRASHED
pause
exit /b 0

:UV_INSTALL_FAILED
echo [ERROR] uv installation failed.
pause
exit /b 1
:MISSING_APP_DIR
echo [ERROR] app directory not found.
pause
exit /b 1
:MISSING_UPDATE_HOST
echo [ERROR] protected update launcher is missing.
pause
exit /b 1
:APP_CRASHED
echo [ERROR] Application crashed.
pause
exit /b 1
