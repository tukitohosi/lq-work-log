param(
  [string]$CredentialsPath,
  [string]$OutputDirectory,
  [int]$VersionCode = 2020103,
  [string]$VersionName = '2.2.2',
  [switch]$SkipWebSync
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectRoot
if ([string]::IsNullOrWhiteSpace($CredentialsPath)) {
  $CredentialsPath = Join-Path $projectsRoot 'L.Q记工本-Android-签名密钥\release-signing.json'
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot "release-android\$VersionName"
}
if (-not (Test-Path -LiteralPath $CredentialsPath -PathType Leaf)) {
  throw "没有找到签名凭据：$CredentialsPath。请先运行 scripts/initialize-android-signing.ps1。"
}

$credentials = Get-Content -LiteralPath $CredentialsPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($property in @('keystore', 'storePassword', 'keyAlias', 'keyPassword')) {
  if ([string]::IsNullOrWhiteSpace([string]$credentials.$property)) {
    throw "签名凭据缺少字段：$property"
  }
}
if (-not (Test-Path -LiteralPath $credentials.keystore -PathType Leaf)) {
  throw "没有找到签名密钥：$($credentials.keystore)"
}

$env:LQ_ANDROID_KEYSTORE = [string]$credentials.keystore
$env:LQ_ANDROID_KEYSTORE_PASSWORD = [string]$credentials.storePassword
$env:LQ_ANDROID_KEY_ALIAS = [string]$credentials.keyAlias
$env:LQ_ANDROID_KEY_PASSWORD = [string]$credentials.keyPassword

Push-Location $projectRoot
try {
  if (-not $SkipWebSync) {
    & npm.cmd run android:sync
    if ($LASTEXITCODE -ne 0) { throw "Android 同步失败（退出码 $LASTEXITCODE）。" }
  }
  & (Join-Path $projectRoot 'android\gradlew.bat') -p (Join-Path $projectRoot 'android') clean lintVitalRelease assembleRelease bundleRelease "-PlqVersionCode=$VersionCode" "-PlqVersionName=$VersionName"
  if ($LASTEXITCODE -ne 0) { throw "Android 正式构建失败（退出码 $LASTEXITCODE）。" }
} finally {
  Pop-Location
  Remove-Item Env:LQ_ANDROID_KEYSTORE, Env:LQ_ANDROID_KEYSTORE_PASSWORD, Env:LQ_ANDROID_KEY_ALIAS, Env:LQ_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$apkSource = Join-Path $projectRoot 'android\app\build\outputs\apk\release\app-release.apk'
$aabSource = Join-Path $projectRoot 'android\app\build\outputs\bundle\release\app-release.aab'
if (-not (Test-Path -LiteralPath $apkSource -PathType Leaf)) { throw "构建后未找到 APK：$apkSource" }
if (-not (Test-Path -LiteralPath $aabSource -PathType Leaf)) { throw "构建后未找到 AAB：$aabSource" }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$apkTarget = Join-Path $OutputDirectory "L.Q记工本-$VersionName-android.apk"
$aabTarget = Join-Path $OutputDirectory "L.Q记工本-$VersionName-android.aab"
Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
Copy-Item -LiteralPath $aabSource -Destination $aabTarget -Force

$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if ([string]::IsNullOrWhiteSpace($sdkRoot)) { throw 'ANDROID_HOME 或 ANDROID_SDK_ROOT 未设置。' }
$apksigner = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'build-tools') -Directory |
  Sort-Object { [version]$_.Name } -Descending |
  ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if (-not $apksigner) { throw 'Android SDK 中没有找到 apksigner.bat。' }

& $apksigner verify --verbose --print-certs $apkTarget
if ($LASTEXITCODE -ne 0) { throw "APK 签名校验失败（退出码 $LASTEXITCODE）。" }
$jarsigner = (Get-Command jarsigner.exe -ErrorAction SilentlyContinue).Source
if (-not $jarsigner) { throw '没有找到 JDK jarsigner.exe。' }
$jarsignerOutput = & $jarsigner -verify $aabTarget 2>&1
$jarsignerExitCode = $LASTEXITCODE
if ($jarsignerExitCode -ne 0) {
  throw "AAB 签名校验失败（退出码 $jarsignerExitCode）：$($jarsignerOutput -join [Environment]::NewLine)"
}
Write-Output 'AAB JAR 签名完整性校验通过。'

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashLines = @($apkTarget, $aabTarget) | ForEach-Object {
    $stream = [System.IO.File]::OpenRead($_)
    try {
      $hash = -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
      "$hash  $(Split-Path -Leaf $_)"
    } finally {
      $stream.Dispose()
    }
  }
} finally {
  $sha256.Dispose()
}
[System.IO.File]::WriteAllLines((Join-Path $OutputDirectory 'SHA256SUMS.txt'), $hashLines, [System.Text.UTF8Encoding]::new($false))

Write-Output "正式 APK：$apkTarget"
Write-Output "正式 AAB：$aabTarget"
Write-Output "SHA-256：$(Join-Path $OutputDirectory 'SHA256SUMS.txt')"
