<#
.SYNOPSIS
  Open the inbound firewall port for the TK Comms Sentinel HTTPS server.

.DESCRIPTION
  Adds an inbound Allow rule for TCP on the given port (default 9443).
  Idempotent: an existing rule with the same name is updated. Use
  -Remove to delete the rule. Must run elevated (Administrator).

.NOTES
  ASCII-only: Windows PowerShell 5.1 reads unmarked .ps1 files as ANSI.
#>
[CmdletBinding()]
param(
  [int]    $Port     = 9443,
  [string] $RuleName = 'TK Comms Sentinel HTTPS',
  [switch] $Remove
)

$ErrorActionPreference = 'Stop'

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue

if ($Remove) {
  if ($existing) {
    $existing | Remove-NetFirewallRule
    Write-Host "[fw] Removed rule '$RuleName'."
  } else {
    Write-Host "[fw] Rule '$RuleName' not present - nothing to remove."
  }
  return
}

if ($existing) {
  $existing | Set-NetFirewallRule -Enabled True -Action Allow
  $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port
  Write-Host "[fw] Updated rule '$RuleName' -> TCP $Port."
} else {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  Write-Host "[fw] Created rule '$RuleName' -> TCP $Port."
}
