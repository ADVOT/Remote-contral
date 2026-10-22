param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$InstallRoot = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'deepseek-harness\plugins\dsh-connect'),
  [string]$AppRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness')
)
$ErrorActionPreference = 'Stop'
$profileDir = Join-Path $DshHome 'profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'Desktop DSH profile not found. Launch DSH once before installation.' }
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
# Install only distribution files; never copy Git history or incidental local files.
$distributionEntries = @('client.js','server.js','index.js','package.json','cordis.patch.yml','icon.svg','Install.ps1','Disable.ps1','Enable-LanAccess.ps1','Install.cmd','LICENSE','README.md','ui/admin.html','ui/admin.js','ui/pair.html','ui/pair.js','ui/style.css','tests/accounts.test.js','tests/admin.test.js','tests/connect.test.js')
$distributionFiles = @()
foreach ($entry in $distributionEntries) {
  $sourceEntry = Join-Path $sourceRoot $entry
  if (-not (Test-Path -LiteralPath $sourceEntry)) { throw "Missing distribution entry: $entry" }
  $distributionFiles += Get-Item -LiteralPath $sourceEntry
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$profileDir = [IO.Path]::GetFullPath($profileDir)
if ($InstallRoot.StartsWith($profileDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Plugin files must live outside the profile directory.' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupRoot = Join-Path (Split-Path $InstallRoot -Parent) ('dsh-connect-backups\' + $stamp)
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','cordis.patch.yml')) {
  $file = Join-Path $profileDir $name
  if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backupRoot $name) }
}
$connectionState = Join-Path $DshHome 'dsh-connect\state.json'
if (Test-Path -LiteralPath $connectionState) { Copy-Item -LiteralPath $connectionState -Destination (Join-Path $backupRoot 'connection-state.json') }
if ((Test-Path -LiteralPath $InstallRoot) -and $sourceRoot -ne $InstallRoot) {
  Copy-Item -LiteralPath $InstallRoot -Destination (Join-Path $backupRoot 'plugin') -Recurse
}
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
if ($sourceRoot -ne $InstallRoot) {
  foreach ($sourceFile in $distributionFiles) {
    $relative = $sourceFile.FullName.Substring($sourceRoot.Length).TrimStart('\')
    $destination = Join-Path $InstallRoot $relative
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destination -Force
  }
}
$scope = Join-Path $profileDir 'node_modules\@local'
New-Item -ItemType Directory -Path $scope -Force | Out-Null
$link = Join-Path $scope 'dsh-connect'
if (Test-Path -LiteralPath $link) {
  $existing = Get-Item -LiteralPath $link
  if (-not $existing.Target -or [IO.Path]::GetFullPath([string]@($existing.Target)[0]) -ne $InstallRoot) { throw "An existing package occupies $link. Nothing was deleted; inspect it before retrying." }
} else { New-Item -ItemType Junction -Path $link -Target $InstallRoot | Out-Null }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.dependencies) { $manifest | Add-Member NoteProperty dependencies ([pscustomobject]@{}) -Force }
$manifest.dependencies | Add-Member NoteProperty '@local/dsh-connect' ('link:' + $InstallRoot.Replace('\','/')) -Force
$bundles = @($manifest.dsh.profile.bundles)
if ('@local/dsh-connect' -notin $bundles) { $manifest.dsh.profile.bundles = @($bundles + '@local/dsh-connect') }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifestPath, (($manifest | ConvertTo-Json -Depth 32) + "`n"), $utf8)

# Refresh only dependency metadata, offline, using the app's own package manager.
$exe = Join-Path $AppRoot 'DeepSeek Harness.exe'
$pnpm = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $pnpm)) {
  $priorElectronMode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $arguments = @('--expose-internals', ('"' + $pnpm + '"'), '--dir', ('"' + $profileDir + '"'), 'install', '--lockfile-only', '--offline', '--ignore-scripts')
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $backupRoot 'pnpm.stdout.log') -RedirectStandardError (Join-Path $backupRoot 'pnpm.stderr.log')
    if ($process.ExitCode -ne 0) { throw "Package metadata refresh failed (exit $($process.ExitCode)). Backups: $backupRoot" }
  } catch {
    foreach ($restoreName in @('package.json','pnpm-lock.yaml')) {
      $saved = Join-Path $backupRoot $restoreName
      if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination (Join-Path $profileDir $restoreName) -Force }
    }
    throw
  } finally { $env:ELECTRON_RUN_AS_NODE = $priorElectronMode }
}
$sourceHashes = $distributionFiles | ForEach-Object {
  $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart('\')
  $target = Join-Path $InstallRoot $relative
  if ((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) { throw "Installed file mismatch: $relative" }
  $relative
}
Write-Host "Installed and hash-checked $($sourceHashes.Count) files: $InstallRoot"
Write-Host "Profile backups: $backupRoot"
Write-Host 'Restart DSH normally, then open Connections in its sidebar. Existing connection settings are preserved; first-time remote access starts disabled.'
