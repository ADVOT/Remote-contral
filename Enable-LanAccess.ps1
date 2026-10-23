[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(1,65535)][int]$Port = 3940,
  [switch]$Radmin,
  [string[]]$RadminPeerAddress = @()
)
$ErrorActionPreference = 'Stop'
if (-not $Radmin -and $RadminPeerAddress.Count) { throw 'Use -Radmin with -RadminPeerAddress.' }
if (-not $WhatIfPreference) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an Administrator PowerShell window.' }
}
$ruleName = "DSH-Connect-TCP-$Port"
$displayName = "DSH Connect ($Port)"
$settings = @{ Direction = 'Inbound'; Action = 'Allow'; Protocol = 'TCP'; LocalPort = $Port; RemoteAddress = @('LocalSubnet','100.64.0.0/10'); LocalAddress = 'Any'; InterfaceAlias = 'Any'; Profile = 'Any'; Enabled = 'True' }
if ($Radmin) {
  foreach ($peer in $RadminPeerAddress) {
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($peer, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $parsed.ToString() -ne $peer -or -not $peer.StartsWith('26.')) {
      throw 'Radmin peer addresses must be individual IPv4 addresses in 26.0.0.0/8.'
    }
  }
  $adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and ($_.Name -match 'Radmin|Famatech' -or $_.InterfaceDescription -match 'Radmin|Famatech') })
  $bindings = @(foreach ($adapter in $adapters) {
    Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like '26.*' -and $_.AddressState -eq 'Preferred' } |
      ForEach-Object { [pscustomobject]@{ Alias = $adapter.Name; Address = $_.IPAddress } }
  })
  if (-not $bindings.Count) { throw 'No online Radmin VPN adapter with a 26.x IPv4 address. Start Radmin VPN, then retry.' }
  $ruleName = "DSH-Connect-Radmin-TCP-$Port"
  $displayName = "DSH Connect Radmin VPN ($Port)"
  $settings.LocalAddress = @($bindings.Address | Select-Object -Unique)
  $settings.InterfaceAlias = @($bindings.Alias | Select-Object -Unique)
  $settings.RemoteAddress = if ($RadminPeerAddress.Count) { @($RadminPeerAddress | Select-Object -Unique) } else { @('26.0.0.0/8') }
}
if ($PSCmdlet.ShouldProcess($ruleName, "Allow inbound TCP $Port from $($settings.RemoteAddress -join ', ') on $($settings.InterfaceAlias -join ', ')")) {
  if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $ruleName @settings | Out-Null
  } else {
    New-NetFirewallRule -Name $ruleName -DisplayName $displayName @settings | Out-Null
  }
  Write-Host "Rule enabled: $ruleName"
  Write-Host 'Only the selected port and network scope are allowed. DSH pairing or account login is still required.'
}
