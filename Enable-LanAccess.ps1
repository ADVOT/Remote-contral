param([ValidateRange(1,65535)][int]$Port = 3940)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an Administrator PowerShell window.' }
$ruleName = "DSH-Connect-TCP-$Port"
if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name $ruleName -DisplayName "DSH Connect ($Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet,100.64.0.0/10 -Profile Any | Out-Null
}
Write-Host "Rule enabled for local subnets and Tailscale addresses only: $ruleName"
