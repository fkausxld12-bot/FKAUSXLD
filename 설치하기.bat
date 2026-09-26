@echo off
title Flower Workshop Setup
chcp 65001 >nul
set "FW_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$fwText = Get-Content -LiteralPath $env:FW_SELF -Raw -Encoding UTF8; $fwMark = '#FW' + '-SETUP#'; Invoke-Expression ($fwText.Substring($fwText.IndexOf($fwMark) + $fwMark.Length))" & exit /b
#FW-SETUP#
# ---------------------------------------------------------------------------
#  꽃 작업장 주문 관리 - 원클릭 설치 / 업데이트
#
#  위 명령줄들은 한글이 없어야 해서(Windows 명령창에서 깨짐) 이 아랫부분을
#  PowerShell로 읽어 실행하는 일만 합니다. 이 아래는 UTF-8로 읽힙니다.
#
#  처음 실행: Node.js 설치 -> 최신 프로그램 받기 -> 바탕화면 아이콘 -> 실행
#  다시 실행: 최신 버전으로 바꾸고 다시 실행 (주문·설정 기록은 따로 보관되어 그대로)
#
#  명령줄이 "... & exit /b" 한 줄로 끝나므로, 업데이트하면서 이 파일 자신을
#  덮어써도 명령창이 파일을 다시 읽지 않아 안전합니다.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # 진행 막대를 끄면 내려받기가 훨씬 빨라집니다.

$zipUrl = 'https://github.com/fkausxld12-bot/FKAUSXLD/archive/refs/heads/main.zip'
$appDir = Join-Path $env:USERPROFILE 'flower-workshop-app'
$tmpDir = Join-Path $env:TEMP ('flower-setup-' + [Guid]::NewGuid().ToString('N'))

function Say([string]$text) { Write-Host ('  ' + $text) }

# 명령이 실패해도(또는 오류 글자를 내도) 설치를 멈추지 않고 조용히 넘어갑니다.
function Invoke-Quietly([scriptblock]$block) {
  $keep = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $block *> $null } catch { } finally { $ErrorActionPreference = $keep }
}

function Get-NodeMajor {
  try {
    $v = & node -v
    if ("$v" -match '^v(\d+)') { return [int]$Matches[1] }
  } catch { }
  return 0
}

Write-Host ''
Write-Host '  ================================================'
Write-Host '    꽃 작업장 주문 관리  -  설치 / 업데이트'
Write-Host '  ================================================'
Write-Host ''

$ok = $false
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # 1) Node.js: 없거나 오래됐으면 설치합니다. (처음 한 번만)
  $major = Get-NodeMajor
  if ($major -ge 22) {
    Say "[1/4] Node.js 확인 - 이미 있습니다. (v$major)"
  } else {
    Say '[1/4] Node.js를 설치합니다. (처음 한 번만, 1~3분 걸립니다)'
    Say '      "이 앱이 디바이스를 변경하도록 허용할까요?" 창이 뜨면 [예]를 눌러 주세요.'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $keep = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      $ErrorActionPreference = $keep
      # 방금 설치한 Node.js를 이 창에서도 바로 쓸 수 있게 경로를 다시 읽습니다.
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
      $major = Get-NodeMajor
    }
    if ($major -lt 18) {
      Start-Process 'https://nodejs.org/ko/download'
      throw 'Node.js를 자동으로 설치하지 못했습니다. 방금 열린 nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행해 주세요.'
    }
    if ($major -lt 22) { Say "      Node.js v$major 로 진행합니다. (송장 도우미는 22 이상이 필요합니다)" }
  }

  # 2) 최신 프로그램 받기
  Say '[2/4] 최신 프로그램을 받는 중...'
  New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
  $zip = Join-Path $tmpDir 'app.zip'
  Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  $src = Get-ChildItem -LiteralPath $tmpDir -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'server.js') } |
    Select-Object -First 1
  if (-not $src) { throw '받은 파일 안에서 프로그램을 찾지 못했습니다.' }

  # 3) 켜져 있는 예전 프로그램 창을 닫고, 프로그램 폴더에 새 파일을 넣습니다.
  #    (주문·설정 기록은 사용자 폴더의 .flower-workshop 에 따로 있어 그대로 남습니다)
  Say "[3/4] 설치하는 중... ($appDir)"
  Invoke-Quietly { taskkill.exe /fi 'WINDOWTITLE eq Flower Workshop Manager*' /t /f }
  Start-Sleep -Milliseconds 800
  $keep = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & robocopy.exe $src.FullName $appDir /E /IS /IT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $copyCode = $LASTEXITCODE
  $ErrorActionPreference = $keep
  if ($copyCode -ge 8) { throw "프로그램 파일을 넣지 못했습니다. (복사 오류 $copyCode)" }

  # 4) 바탕화면 아이콘 두 개: 프로그램 실행 / 업데이트(이 파일을 다시 실행)
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $icons = @(
    @{ Name = '꽃 작업장 주문'; File = '시작하기.bat' },
    @{ Name = '꽃 작업장 업데이트'; File = '설치하기.bat' }
  )
  $made = @()
  foreach ($icon in $icons) {
    if (-not (Test-Path -LiteralPath (Join-Path $appDir $icon.File))) { continue }
    $lnk = $shell.CreateShortcut((Join-Path $desktop ($icon.Name + '.lnk')))
    $lnk.TargetPath = Join-Path $appDir $icon.File
    $lnk.WorkingDirectory = $appDir
    $lnk.Description = $icon.Name
    $lnk.Save()
    $made += '[' + $icon.Name + ']'
  }
  Say ('[4/4] 바탕화면에 ' + ($made -join ' · ') + ' 아이콘을 만들었습니다.')

  $version = ''
  $found = Select-String -LiteralPath (Join-Path $appDir 'server.js') -Pattern "APP_VERSION = '([^']+)'" | Select-Object -First 1
  if ($found) { $version = $found.Matches[0].Groups[1].Value }

  Write-Host ''
  Say "설치 완료! (버전 $version) 프로그램을 시작합니다."
  Say '다음부터는 바탕화면의 [꽃 작업장 주문]을 두 번 누르면 됩니다.'
  Say '새 버전이 나오면 [꽃 작업장 업데이트]를 두 번 누르면 됩니다.'
  Start-Process -FilePath (Join-Path $appDir '시작하기.bat') -WorkingDirectory $appDir
  $ok = $true
} catch {
  Write-Host ''
  Say ('설치하지 못했습니다: ' + $_.Exception.Message)
  Say '인터넷 연결을 확인하고 다시 실행해 주세요. 계속 안 되면 이 창을 사진으로 찍어 보내 주세요.'
} finally {
  if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($ok) {
  Say '이 창은 10초 뒤에 저절로 닫힙니다.'
  Start-Sleep -Seconds 10
} else {
  Read-Host '  엔터를 누르면 창이 닫힙니다' | Out-Null
}
