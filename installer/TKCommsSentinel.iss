; TKCommsSentinel.iss -- Inno Setup script for TK Comms Sentinel
;
; Wraps the standalone, versioned package (see installer\README.md) into a
; single-click Windows installer: copies the package, then runs the same
; scripts a manual install would run, in order:
;   activate-version -> new-selfsigned-cert -> write-env -> svc-install
;   -> open-firewall -> seed-admin
;
; Compile with (MyAppVersion should match backend\package.json):
;   ISCC.exe /DMyAppVersion=1.0.0 TKCommsSentinel.iss
; Source files come from ..\package (build-package.ps1's output) -- build
; that first. ASCII-only, matching every other script in this project.

#ifndef MyAppVersion
  #define MyAppVersion "1.3.0"
#endif
#define MyAppName "TK Comms Sentinel"
#define MyAppPublisher "TK Comms Sentinel"
#define PackageDir "..\package"

[Setup]
; This GUID identifies the app across versions -- generated once, never
; change it. Lets Windows / future installer versions recognize an upgrade.
AppId={{8EBEE28B-2762-4C8A-AC9E-B83E0FA3F228}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TKCommsSentinel
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-pkg
OutputBaseFilename=TKCommsSentinel-Setup-{#MyAppVersion}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
SetupIconFile=assets\icon.ico
WizardImageFile=assets\wizard-large.png
WizardSmallImageFile=assets\wizard-small.png
UninstallDisplayIcon={app}\icon.ico
; The app terminates its own TLS -- nothing else to configure here.
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PackageDir}\versions\*";   DestDir: "{app}\versions";   Flags: recursesubdirs createallsubdirs
Source: "{#PackageDir}\node\*";       DestDir: "{app}\node";       Flags: recursesubdirs createallsubdirs
Source: "{#PackageDir}\tools\*";      DestDir: "{app}\tools";      Flags: recursesubdirs createallsubdirs
Source: "{#PackageDir}\installer\*";  DestDir: "{app}\installer";  Flags: recursesubdirs createallsubdirs
Source: "assets\icon.ico";            DestDir: "{app}";            Flags: ignoreversion

[Icons]
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

; Runs before Inno deletes any files -- stop/remove services and the
; firewall rule first. data\ (DB, certs, .env) is never in [Files], so
; Inno's uninstaller does not track or remove it: it survives uninstall.
[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\installer\scripts\svc-uninstall.ps1"" -InstallRoot ""{app}"""; \
  RunOnceId: "TkcsSvcUninstall"; Flags: runhidden waituntilterminated
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\installer\scripts\open-firewall.ps1"" -Remove"; \
  RunOnceId: "TkcsFirewallRemove"; Flags: runhidden waituntilterminated

[Code]
var
  ConfigPage: TInputQueryWizardPage;
  HttpsPort: string;
  AdminUser: string;
  AdminPass: string;
  InstallFailed: Boolean;
  FailedStep: string;

function SetEnvironmentVariable(lpName, lpValue: string): BOOL;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  ConfigPage := CreateInputQueryPage(wpSelectDir,
    'Initial Configuration', 'Set the HTTPS port and the first admin account',
    'These can be changed later from Admin > Settings, or by editing data\.env after install.');
  ConfigPage.Add('HTTPS port:', False);
  ConfigPage.Add('Admin username:', False);
  ConfigPage.Add('Admin password:', True);
  ConfigPage.Add('Confirm password:', True);
  ConfigPage.Values[0] := '9443';
  ConfigPage.Values[1] := 'admin';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNum: Longint;
begin
  Result := True;
  if CurPageID = ConfigPage.ID then
  begin
    PortNum := StrToIntDef(ConfigPage.Values[0], -1);
    if (PortNum < 1) or (PortNum > 65535) then
    begin
      MsgBox('Enter a valid HTTPS port (1-65535).', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if Trim(ConfigPage.Values[1]) = '' then
    begin
      MsgBox('Enter an admin username.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if Length(ConfigPage.Values[2]) < 4 then
    begin
      MsgBox('Choose a password of at least 4 characters.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if ConfigPage.Values[2] <> ConfigPage.Values[3] then
    begin
      MsgBox('Passwords do not match.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    HttpsPort := ConfigPage.Values[0];
    AdminUser := ConfigPage.Values[1];
    AdminPass := ConfigPage.Values[2];
  end;
end;

// Runs one step of the post-install sequence. Returns True on success
// (ResultCode 0). On failure, records the step name (once) so the final
// summary can name it, and logs full detail for diagnosis.
function RunStep(const StepName, Filename, Params: string): Boolean;
var
  ResultCode: Integer;
begin
  Log('[TKCS] Step: ' + StepName + ' -- ' + Filename + ' ' + Params);
  Result := Exec(Filename, Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Result then Result := (ResultCode = 0);
  if not Result then
  begin
    Log('[TKCS] Step FAILED: ' + StepName + ' (exit code ' + IntToStr(ResultCode) + ')');
    if FailedStep = '' then FailedStep := StepName;
    InstallFailed := True;
  end
  else
    Log('[TKCS] Step OK: ' + StepName);
end;

function PS(const ScriptRelPath, Args: string): string;
begin
  Result := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{app}') + '\installer\scripts\' + ScriptRelPath + '" ' + Args;
end;

procedure RunPostInstallSteps;
var
  AppDir, NodeExe, SeedParams: string;
  AlreadyConfigured: Boolean;
begin
  AppDir := ExpandConstant('{app}');
  NodeExe := AppDir + '\node\node.exe';
  InstallFailed := False;
  FailedStep := '';

  WizardForm.StatusLabel.Caption := 'Configuring TK Comms Sentinel (this can take a minute)...';
  WizardForm.StatusLabel.Repaint;

  // Every backend script that loads data\.env directly (not as an NSSM
  // service) looks at TKCS_DATA_DIR first -- set it for this process so it
  // is inherited by seed-admin.js below. See seed-admin.js's own comment.
  SetEnvironmentVariable('TKCS_DATA_DIR', AppDir + '\data');

  if not RunStep('Activate version', 'powershell.exe',
    PS('activate-version.ps1', '-InstallRoot "' + AppDir + '"')) then Exit;

  // Re-running Setup over an existing install (repair, or installing the
  // same version again) must never touch an existing data\.env: the cert
  // step below would regenerate server.pfx with a new password, and since
  // write-env.ps1 correctly refuses to overwrite an existing .env, the old
  // (now-mismatched) password would be left on disk -- breaking TLS the
  // next time the service restarts, silently, until then. So: only
  // generate a certificate and config the first time.
  AlreadyConfigured := FileExists(AppDir + '\data\.env');

  if AlreadyConfigured then
    Log('[TKCS] data\.env already exists -- skipping cert generation and config write (leaving them untouched).')
  else
  begin
    if not RunStep('Generate TLS certificate', 'powershell.exe',
      PS('new-selfsigned-cert.ps1', '-OutDir "' + AppDir + '\data\certs"')) then Exit;

    if not RunStep('Write configuration', 'powershell.exe',
      PS('write-env.ps1', '-Root "' + AppDir + '" -HttpsPort ' + HttpsPort)) then Exit;
  end;

  if not RunStep('Register Windows services', 'powershell.exe',
    PS('svc-install.ps1', '-InstallRoot "' + AppDir + '" -Start')) then Exit;

  if not RunStep('Open firewall port', 'powershell.exe',
    PS('open-firewall.ps1', '-Port ' + HttpsPort)) then Exit;

  SeedParams := '"' + AppDir + '\current\backend\scripts\seed-admin.js" "' +
    AdminUser + '" "' + AdminPass + '" admin';
  if not RunStep('Create admin account', NodeExe, SeedParams) then Exit;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RunPostInstallSteps;
end;

function InstallFailureMessage: string;
begin
  Result := 'Setup finished copying files, but the "' + FailedStep +
    '" step failed.' + #13#10#13#10 +
    'Files are installed at ' + ExpandConstant('{app}') + '.' + #13#10 +
    'See the setup log for details, and installer\README.md for how to ' +
    're-run the individual step by hand.';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    if InstallFailed then
      MsgBox(InstallFailureMessage, mbError, MB_OK)
    else
      // Append to Inno's own finish text rather than replacing it. Every
      // account -- including this freshly created admin -- must enroll in
      // two-factor authentication (scan a QR code) on its very first login;
      // this is the application's own security design, not something this
      // installer can skip. Worth saying up front so it doesn't look like
      // a lockout.
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
        'Open: https://localhost:' + HttpsPort + #13#10#13#10 +
        'The first login for any account, including the ' +
        'admin account you just created, requires setting up two-factor ' +
        'authentication: you will be shown a QR code to scan with an ' +
        'authenticator app (e.g. Google Authenticator or Microsoft ' +
        'Authenticator) before you get full access.';
  end;
end;

// Standard location Inno writes an uninstall registry entry to, keyed by
// AppId -- this is how we recognize an existing install, independent of
// which directory it was installed to (InstallLocation is read from the
// same key below, once we know it exists).
const
  UninstallKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{8EBEE28B-2762-4C8A-AC9E-B83E0FA3F228}_is1';

function InitializeSetup: Boolean;
var
  ExistingPath, Msg: string;
  Choice: Integer;
begin
  Result := True;
  if not RegKeyExists(HKLM, UninstallKey) then Exit;

  ExistingPath := '';
  RegQueryStringValue(HKLM, UninstallKey, 'InstallLocation', ExistingPath);

  Msg := 'TK Comms Sentinel is already installed';
  if ExistingPath <> '' then Msg := Msg + ' at:' + #13#10 + ExistingPath;
  Msg := Msg + '.' + #13#10#13#10 +
    'Continuing will reconfigure the Windows services and firewall rule, ' +
    'and (re-)create the admin account with whatever username/password ' +
    'you enter next. Your existing database, TLS certificate, and ' +
    'settings are left untouched.' + #13#10#13#10 +
    'Click Yes to continue (repair/reconfigure). Click No to cancel -- ' +
    'use "Uninstall TK Comms Sentinel" in Control Panel first if you want ' +
    'a completely clean reinstall.';

  Choice := MsgBox(Msg, mbConfirmation, MB_YESNO);
  Result := (Choice = IDYES);
end;
