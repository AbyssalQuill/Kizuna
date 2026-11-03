$ErrorActionPreference = 'Stop'
$root = 'C:\Users\17367\Desktop\Kizuna Public'
$exe = Join-Path $root 'QQ-Bridge-packaging\dist-sfx\Kizuna-Setup-5.0.1.exe'
$gh = 'E:\DeepSeek Harness\gh\bin\gh.exe'
$relId = '432415381'
$tag = 'v5.0.1'
$repo = 'AbyssalQuill/Kizuna'

Write-Host "=== 1) Check artifact ==="
$it = Get-Item $exe
Write-Host "File: $($it.FullName)"
Write-Host "Size: $($it.Length) bytes ($([math]::Round($it.Length / 1GB, 2)) GiB)"
if ($it.Length -ge 2147483648) {
    throw "File exceeds 2 GiB GitHub limit!"
}

Write-Host "=== 2) Upload asset via curl -T ==="
$token = & $gh auth token
$url = "https://uploads.github.com/repos/$repo/releases/$relId/assets?name=Kizuna-Setup-5.0.1.exe"

$sw = [Diagnostics.Stopwatch]::StartNew()
& curl.exe --fail-with-body -X POST `
    -H "Authorization: token $token" `
    -H "Content-Type: application/octet-stream" `
    -T $exe `
    --keepalive-time 30 `
    --progress-bar `
    $url

$curlExit = $LASTEXITCODE
$sw.Stop()
Write-Host "Upload exit code: $curlExit, elapsed: $([math]::Round($sw.Elapsed.TotalSeconds, 1))s"

if ($curlExit -ne 0) {
    throw "curl upload failed with exit code $curlExit"
}

Write-Host "=== 3) Publish release (draft -> false) ==="
& $gh release edit $tag --draft=false --repo $repo

Write-Host "=== 4) Verify release ==="
& $gh release view $tag --repo $repo

Write-Host "=== ALL DONE ==="
