<#
.SYNOPSIS
  work-portal 배포 파일들을 archive 폴더에 날짜 버전으로 저장.
  GitHub에는 고정 파일명(index.html 등)만 push, archive/ 는 로컬 전용.

.USAGE
  cd C:\Users\shinf\Workspace\apps\work-portal
  .\save-version.ps1
#>

$root    = $PSScriptRoot
$archDir = Join-Path $root "archive"
if (-not (Test-Path $archDir)) { New-Item -ItemType Directory -Path $archDir | Out-Null }

$ts    = Get-Date -Format "yyyyMMddHHmm"
$files = @("index.html", "defect-management.html", "overtime-work.html")

Write-Host "`n[work-portal] 버전 저장 - $ts`n" -ForegroundColor Cyan

foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src)) { Write-Host "  건너뜀 (없음): $f" -ForegroundColor DarkGray; continue }

    $base = [System.IO.Path]::GetFileNameWithoutExtension($f)
    $dst  = Join-Path $archDir "${base}_${ts}.html"
    Copy-Item $src $dst
    Write-Host "  저장: $f  →  archive/${base}_${ts}.html" -ForegroundColor Green
}

Write-Host "`n완료. archive 폴더에 저장되었습니다." -ForegroundColor Cyan
Write-Host "git push 준비 완료 (archive/ 폴더는 .gitignore에서 제외됩니다)`n"
