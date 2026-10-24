@echo off
REM ============================================================
REM Kizuna Pro - 极速重建前端并同步（PWSH 原生隐藏启动，无黑框）
REM ============================================================
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\build-fast.ps1"
exit /b 0
