param(
  [string]$KeyDirectory,
  [string]$KeytoolPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectRoot
if ([string]::IsNullOrWhiteSpace($KeyDirectory)) {
  $KeyDirectory = Join-Path $projectsRoot 'L.Q记工本-Android-签名密钥'
}
if ([string]::IsNullOrWhiteSpace($KeytoolPath)) {
  $command = Get-Command keytool.exe -ErrorAction SilentlyContinue
  if ($command) { $KeytoolPath = $command.Source }
}
if ([string]::IsNullOrWhiteSpace($KeytoolPath) -or -not (Test-Path -LiteralPath $KeytoolPath -PathType Leaf)) {
  throw '没有找到 keytool.exe；请通过 -KeytoolPath 指定 JDK 内的 keytool.exe。'
}

$keystorePath = Join-Path $KeyDirectory 'lq-jigongben-release.p12'
$credentialsPath = Join-Path $KeyDirectory 'release-signing.json'
$readmePath = Join-Path $KeyDirectory '签名密钥说明.md'
foreach ($path in @($keystorePath, $credentialsPath)) {
  if (Test-Path -LiteralPath $path) {
    throw "签名材料已存在，已停止以避免覆盖：$path"
  }
}

New-Item -ItemType Directory -Path $KeyDirectory -Force | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\SYSTEM', 'FullControl', $inheritance, 'None', 'Allow')))
Set-Acl -LiteralPath $KeyDirectory -AclObject $acl

$randomBytes = New-Object byte[] 36
[System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
$password = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$alias = 'lq-jigongben-release'

& $KeytoolPath -genkeypair -v `
  -storetype PKCS12 `
  -keystore $keystorePath `
  -storepass $password `
  -keypass $password `
  -alias $alias `
  -keyalg RSA `
  -keysize 4096 `
  -sigalg SHA256withRSA `
  -validity 36500 `
  -dname 'CN=L.Q记工本,O=L.Q'
if ($LASTEXITCODE -ne 0) { throw "keytool 创建签名密钥失败（退出码 $LASTEXITCODE）。" }

$credentials = [ordered]@{
  keystore = $keystorePath
  storePassword = $password
  keyAlias = $alias
  keyPassword = $password
}
[System.IO.File]::WriteAllText($credentialsPath, ($credentials | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

$readme = @"
# L.Q记工本 Android 正式签名密钥

此目录包含 Android 正式版持续升级所必需的签名密钥与凭据。

- `lq-jigongben-release.p12`：正式签名密钥
- `release-signing.json`：构建所需凭据（明文，但目录访问权限已限制为当前 Windows 用户与 SYSTEM）

请把整个目录复制到至少一个独立、离线、加密的存储介质。丢失密钥后，已安装用户将无法直接升级到用新密钥签名的版本。不要把本目录提交到代码仓库、网盘公开链接或聊天消息。
"@
[System.IO.File]::WriteAllText($readmePath, $readme, [System.Text.UTF8Encoding]::new($false))

Write-Output "签名密钥已创建：$keystorePath"
Write-Output "受保护凭据：$credentialsPath"
Write-Output "备份说明：$readmePath"
