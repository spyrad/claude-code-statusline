@echo off
rem Double-click installer for claude-code-statusline.
rem Uses install.ps1 next to this file if present, otherwise downloads the latest one.
rem Extra options are passed through, e.g.:  install.cmd -ShowCosts
setlocal
if exist "%~dp0install.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/spyrad/claude-code-statusline/main/install.ps1'))) %*"
)
echo.
pause
