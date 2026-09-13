# TK Comms Sentinel -- License Issuer GUI
# ASCII-only script. Calls issue-license.js via Node.
# Usage: run LicenseIssuer.bat (hides the console window automatically).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $ScriptDir)

# Locate node.exe: vendor bundle first, then system PATH
$NodeExe = "$RepoRoot\vendor\node\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node.exe" }

$IssueScript = "$ScriptDir\issue-license.js"

# ── Form ─────────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text            = "TK Comms Sentinel -- License Issuer"
$form.Size            = New-Object System.Drawing.Size(560, 440)
$form.StartPosition   = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox     = $false
$form.Font            = New-Object System.Drawing.Font("Segoe UI", 10)
$form.BackColor       = [System.Drawing.Color]::FromArgb(245, 247, 250)

function Label($text, $x, $y) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text     = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.AutoSize = $true
    $form.Controls.Add($l)
    return $l
}

function TextBox($x, $y, $w, $text) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y)
    $t.Width    = $w
    $t.Text     = $text
    $t.Font     = New-Object System.Drawing.Font("Consolas", 10)
    $form.Controls.Add($t)
    return $t
}

# Fingerprint
Label "Machine Fingerprint:" 20 20
$tbFP = TextBox 20 44 500 ""
$tbFP.CharacterCasing = "Upper"
$tbFP.MaxLength = 23

# Customer name
Label "Customer:" 20 90
$tbCust = TextBox 20 114 250 ""

# Expiry date
Label "Expiry Date (YYYY-MM-DD):" 20 160
$dtPicker = New-Object System.Windows.Forms.DateTimePicker
$dtPicker.Location = New-Object System.Drawing.Point(20, 184)
$dtPicker.Width    = 200
$dtPicker.Format   = "Custom"
$dtPicker.CustomFormat = "yyyy-MM-dd"
$dtPicker.Value    = (Get-Date).AddYears(1)
$form.Controls.Add($dtPicker)

# Grace days
Label "Grace Days:" 300 160
$tbGrace = TextBox 300 184 80 "30"

# Generate button
$btnGen = New-Object System.Windows.Forms.Button
$btnGen.Text      = "Generate License Key"
$btnGen.Location  = New-Object System.Drawing.Point(20, 230)
$btnGen.Size      = New-Object System.Drawing.Size(200, 36)
$btnGen.BackColor = [System.Drawing.Color]::FromArgb(0, 120, 180)
$btnGen.ForeColor = [System.Drawing.Color]::White
$btnGen.FlatStyle = "Flat"
$btnGen.Font      = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($btnGen)

# Status label
$lblStatus = New-Object System.Windows.Forms.Label
$lblStatus.Location = New-Object System.Drawing.Point(230, 240)
$lblStatus.AutoSize = $true
$lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
$form.Controls.Add($lblStatus)

# Output
Label "License Key:" 20 280
$tbOut = New-Object System.Windows.Forms.TextBox
$tbOut.Location   = New-Object System.Drawing.Point(20, 304)
$tbOut.Size       = New-Object System.Drawing.Size(500, 58)
$tbOut.Multiline  = $true
$tbOut.ReadOnly   = $true
$tbOut.ScrollBars = "Vertical"
$tbOut.Font       = New-Object System.Drawing.Font("Consolas", 9)
$tbOut.BackColor  = [System.Drawing.Color]::FromArgb(230, 240, 230)
$form.Controls.Add($tbOut)

# Copy button
$btnCopy = New-Object System.Windows.Forms.Button
$btnCopy.Text     = "Copy"
$btnCopy.Location = New-Object System.Drawing.Point(20, 372)
$btnCopy.Size     = New-Object System.Drawing.Size(90, 30)
$btnCopy.Enabled  = $false
$form.Controls.Add($btnCopy)

# ── Event handlers ────────────────────────────────────────────────────────────
$btnGen.Add_Click({
    $fp     = $tbFP.Text.Trim()
    $cust   = $tbCust.Text.Trim()
    $expiry = $dtPicker.Value.ToString("yyyy-MM-dd")
    $grace  = $tbGrace.Text.Trim()

    # Basic validation
    if ($fp -notmatch '^[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}$') {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = "Invalid fingerprint format (XXXXX-XXXXX-XXXXX-XXXXX)"
        return
    }
    if ($cust -eq "") {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = "Customer name is required."
        return
    }
    if ($grace -notmatch '^\d+$') {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = "Grace days must be a number."
        return
    }

    $lblStatus.ForeColor = [System.Drawing.Color]::DarkGray
    $lblStatus.Text = "Generating..."
    $form.Refresh()

    try {
        $result = & $NodeExe $IssueScript $fp $expiry $cust $grace 2>&1
        $key = ($result | Where-Object { $_ -match '^[A-Za-z0-9_\-].*\.[A-Za-z0-9_\-]+$' }) | Select-Object -First 1
        if ($key) {
            $tbOut.Text      = $key.Trim()
            $btnCopy.Enabled = $true
            $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
            $lblStatus.Text = "Done."
        } else {
            $tbOut.Text = ($result -join "`r`n")
            $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
            $lblStatus.Text = "Error -- see output above."
        }
    } catch {
        $lblStatus.ForeColor = [System.Drawing.Color]::DarkRed
        $lblStatus.Text = "Failed: $_"
    }
})

$btnCopy.Add_Click({
    [System.Windows.Forms.Clipboard]::SetText($tbOut.Text.Trim())
    $lblStatus.ForeColor = [System.Drawing.Color]::DarkGreen
    $lblStatus.Text = "Copied to clipboard."
})

$form.ShowDialog() | Out-Null
