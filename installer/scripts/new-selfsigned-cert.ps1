<#
.SYNOPSIS
  Generate a self-signed TLS certificate (PFX) for the standalone TK Comms
  Sentinel HTTPS server, using only Windows built-ins (no OpenSSL).

.DESCRIPTION
  Creates an RSA-2048 self-signed certificate via New-SelfSignedCertificate,
  exports it to a password-protected .pfx that Node loads directly
  (https.createServer({ pfx, passphrase })), then removes the temporary
  certificate from the Windows store.

  On success it prints, on their own lines, values the installer can capture
  and write into backend\.env:
    TLS_PFX_PATH=<path>
    TLS_PFX_PASSWORD=<password>

.NOTES
  ASCII-only on purpose: Windows PowerShell 5.1 reads unmarked .ps1 files as
  ANSI, so any non-ASCII byte corrupts parsing.
#>
[CmdletBinding()]
param(
  [string]   $OutDir       = (Join-Path $PSScriptRoot '..\..\data\certs'),
  [string]   $CommonName   = $env:COMPUTERNAME,
  [string[]] $DnsNames     = @(),
  [string]   $PfxPassword  = '',
  [int]      $Days         = 3650,
  [ValidateSet('LocalMachine','CurrentUser')]
  [string]   $StoreLocation = 'LocalMachine'
)

$ErrorActionPreference = 'Stop'

# Build the SAN / subject name list: CN first, then any extra DNS names, plus
# localhost so local health checks over TLS validate by name.
$names = New-Object System.Collections.Generic.List[string]
$names.Add($CommonName)
foreach ($n in $DnsNames) { if ($n -and -not $names.Contains($n)) { $names.Add($n) } }
if (-not $names.Contains('localhost')) { $names.Add('localhost') }

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$pfxPath = Join-Path $OutDir 'server.pfx'

if ([string]::IsNullOrEmpty($PfxPassword)) {
  $PfxPassword = [System.Guid]::NewGuid().ToString('N')
}
$securePw = ConvertTo-SecureString -String $PfxPassword -AsPlainText -Force

$storePath = "Cert:\$StoreLocation\My"
Write-Host "[cert] Creating self-signed certificate for: $($names -join ', ')"

$cert = New-SelfSignedCertificate `
  -Subject "CN=$CommonName" `
  -DnsName $names `
  -CertStoreLocation $storePath `
  -KeyAlgorithm RSA -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddDays($Days) `
  -FriendlyName 'TK Comms Sentinel TLS'

try {
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePw -Force | Out-Null
  Write-Host "[cert] Exported PFX: $pfxPath"
}
finally {
  # Do not leave the private key sitting in the machine store.
  Remove-Item -LiteralPath ("$storePath\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue
}

Write-Host "[cert] Thumbprint: $($cert.Thumbprint)"
Write-Host "[cert] Valid until: $($cert.NotAfter.ToString('yyyy-MM-dd'))"

# Emit the capture lines on the OUTPUT stream (not Write-Host) so a caller can
# collect them with  $o = & new-selfsigned-cert.ps1 ...  as well as see them
# on the console when run via powershell.exe -File.
Write-Output "TLS_PFX_PATH=$pfxPath"
Write-Output "TLS_PFX_PASSWORD=$PfxPassword"
