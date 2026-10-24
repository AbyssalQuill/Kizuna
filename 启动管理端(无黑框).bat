@echo off
REM ============================================================
REM Kizuna Pro - 启动管理端（PWSH 原生隐藏启动，桌面无黑框）
REM ============================================================
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$root = '%~dp0'.TrimEnd('\'); Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',('Set-Location \"' + $root + '\"; npm run dev'); Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5173'"
exit /b 0
