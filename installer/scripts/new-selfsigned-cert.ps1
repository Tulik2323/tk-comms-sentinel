<#
.SYNOPSIS
  Generate a self-signed TLS certificate (PFX) for the standalone TK Comms
  Sentinel HTTPS server, using only Windows built-ins (no OpenSSL).

.DESCRIPTION
  Creates an RSA-2048 self-signed certificate via New-SelfSignedCertificate,
  exports it to a password-protected .pfx that Node loads directly
  (https.createServer({ pfx, passphrase })), then removes the temporary
  certificate from the Windows store.

  Writes the path and password to a companion file, <OutDir>\pfx-info.env,
  as PFX_PATH=... / PFX_PASSWORD=... lines. A caller reads that file with
  Get-Content instead of capturing this script's console output: capturing
  script output via "$x = & script.ps1" proved unreliable in the field
  (empty values reached backend\.env after a real install run), so treat the
  file as the source of truth, not the printed TLS_PFX_PATH=/TLS_PFX_PASSWORD=
  lines below (kept only for human eyes watching the console).

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

# Source of truth for callers: a plain file on disk, written directly by this
# process. No console-output capture involved, so nothing can be lost to a
# quirk of how the caller invoked us (variable assignment, piping, a repeated
# paste, etc.) -- that is exactly what went wrong the first time this was
# wired up by capturing "$x = & new-selfsigned-cert.ps1 ...".
$infoPath = Join-Path $OutDir 'pfx-info.env'
$infoText = "PFX_PATH=$pfxPath`r`nPFX_PASSWORD=$PfxPassword`r`n"
[System.IO.File]::WriteAllText($infoPath, $infoText, (New-Object System.Text.ASCIIEncoding))
Write-Host "[cert] Wrote credentials file: $infoPath"

# Also emit on the OUTPUT stream for a caller that prefers to capture output
# directly (works when invoked exactly once per PowerShell statement).
Write-Output "TLS_PFX_PATH=$pfxPath"
Write-Output "TLS_PFX_PASSWORD=$PfxPassword"
