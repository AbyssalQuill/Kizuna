# ============================================================
# Kizuna - 前端极速重构与同步 (PowerShell Native)
# ============================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$t0 = Get-Date

Write-Host "[1/2] 正在极速编译前端 (Vite Build)..." -ForegroundColor Cyan
$env:VITE_SOURCEMAP = 'false'
# 仅执行 vite build（依靠 esbuild 原生极速打包，跳过耗时的全量类型重复校验与 sourcemap 写入）
& npx.cmd vite build

if ($LASTEXITCODE -ne 0) {
    Write-Error "前端编译失败，退出码: $LASTEXITCODE"
    exit $LASTEXITCODE
}

$elapsed = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
Write-Host "[2/2] 编译完成，耗时 ${elapsed}s。正在同步产物至运行时..." -ForegroundColor Green

$distSrc = Join-Path $root 'dist'
$liveDist = 'D:\Kizuna\resources\runtime\dist'

if ((Test-Path $distSrc) -and (Test-Path (Split-Path $liveDist -Parent))) {
    if (-not (Test-Path $liveDist)) {
        New-Item -ItemType Directory -Force -Path $liveDist | Out-Null
    }
    Copy-Item -Path (Join-Path $distSrc '*') -Destination $liveDist -Recurse -Force
    Write-Host "已同步产物至: $liveDist" -ForegroundColor Green
}

Write-Host "前端极速重建完毕！" -ForegroundColor Green
