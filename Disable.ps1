param([string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'))
$ErrorActionPreference = 'Stop'
$file = Join-Path $DshHome 'profiles\desktop\package.json'
$backup = $file + '.before-disable-dsh-connect-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
Copy-Item -LiteralPath $file -Destination $backup
$manifest = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
$manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne '@local/dsh-connect' })
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($file, (($manifest | ConvertTo-Json -Depth 32) + "`n"), $utf8)
Write-Host 'Plugin disabled for the next DSH restart. No files or device records were deleted.'
Write-Host "Backup: $backup"
