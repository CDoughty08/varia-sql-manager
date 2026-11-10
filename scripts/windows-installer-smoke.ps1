$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$version = (Get-Content package.json | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/Varia-SQL-Manager-$version-Windows-x64-Setup.exe").Path
# Only run this on an ephemeral CI runner: the silent checks create an actual per-user installation and shortcuts.
if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) { throw 'Installer smoke tests require a GitHub-hosted runner.' }
$installDir = Join-Path $env:RUNNER_TEMP ('varia-install-' + [guid]::NewGuid().ToString('N'))
$exe = Join-Path $installDir 'Varia SQL Manager.exe'

function Get-ProcessWindows($process) {
  $process.Refresh()
  if ($process.HasExited) { throw "Installer exited before displaying its wizard: $($process.ExitCode)" }
  $byProcess = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
  return [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byProcess)
}
function Find-Controls($window, $type) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Find-Button($process, $name) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $windows = @(Get-ProcessWindows $process)
    foreach ($window in $windows) {
      $buttons = @(Find-Controls $window ([System.Windows.Automation.ControlType]::Button))
      foreach ($button in $buttons) {
        if ($button.Current.Name.Replace('&', '') -match $name) { return $button }
      }
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $info = @($windows | ForEach-Object { "window='$($_.Current.Name)' class='$($_.Current.ClassName)'" }) -join ', '
  throw "Installer button not found: $name; $info"
}
function Invoke-Button($button) {
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

# Repeated fresh launches exercise the formerly intermittent per-user path lookup, before any installation exists.
# Also check that --updated and lookalike flags cannot skip the first wizard page.
$interactiveCases = @('') * 12 + @('--updated', '--silent-extra')
$caseNumber = 0
foreach ($flag in $interactiveCases) {
  $caseNumber++
  Write-Host "Checking interactive installer case $caseNumber/$($interactiveCases.Count), flag: '$flag'"
  $arguments = @()
  if ($flag) { $arguments += $flag }
  $arguments += "/D=$installDir"
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru
  try {
    if (Test-Path -LiteralPath $exe) { throw "Installer wrote application files before confirmation ($flag)." }
    $next = Find-Button $process '^Next'
    if ($caseNumber -eq 1) {
      Invoke-Button $next
      Write-Host 'Welcome page passed; checking install-mode choices.'
      $deadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $radios = @(foreach ($window in (Get-ProcessWindows $process)) { Find-Controls $window ([System.Windows.Automation.ControlType]::RadioButton) })
      } while ($radios.Count -lt 2 -and (Get-Date) -lt $deadline)
      $names = @($radios | ForEach-Object { $_.Current.Name })
      if (-not ($names -match 'all users') -or -not ($names -match 'Only for.*me')) { throw "Missing user and all-users choices: $names" }
      Invoke-Button (Find-Button $process '^Next')
      $installButton = Find-Button $process '^Install$'
      if (Test-Path -LiteralPath $exe) { throw 'Installer wrote application files before Install was clicked.' }
    }
  } finally {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  }
}

# Exercise both supported unattended flags against an actual per-user install in the runner's temp directory.
foreach ($flag in @('--silent', '/S')) {
  Write-Host "Checking silent installer flag: '$flag'"
  $process = Start-Process -FilePath $installer -ArgumentList @($flag, '/currentuser', "/D=$installDir") -PassThru
  $deadline = (Get-Date).AddSeconds(180)
  try {
    do {
      Start-Sleep -Milliseconds 250
      $process.Refresh()
      if (-not $process.HasExited -and $process.MainWindowHandle -ne 0) { throw "Installer displayed a window with $flag." }
    } while (-not $process.HasExited -and (Get-Date) -lt $deadline)
    if (-not $process.HasExited) { throw "Installer timed out with $flag." }
    if ($process.ExitCode -ne 0) { throw "Installer failed with ${flag}: $($process.ExitCode)" }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Installer did not create the app with $flag." }
  } finally {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  }
}
Write-Host 'Interactive installer choices, explicit confirmation, and silent flags passed.'

# The staged update (docs/updates.md) against that installation: its own helper unpacks this build's archive beside it,
# then a copy of the helper swaps it in, as Restart to Update does once Varia has closed. The helper has no console, so
# each run is waited for.
function Invoke-Helper($path, $arguments) {
  $process = Start-Process -FilePath $path -ArgumentList $arguments -WorkingDirectory $installDir -PassThru
  if (-not $process.WaitForExit(300000)) { $process.Kill($true); throw "The update helper timed out: $($arguments[0])" }
  return $process.ExitCode
}
$appName = 'Varia SQL Manager.exe'
$helper = Join-Path $installDir 'resources\updater\Varia.Updater.exe'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'The installation has no update helper.' }
$archive = (Resolve-Path "dist/Varia-SQL-Manager-$version-win-x64.zip").Path
$stream = [IO.File]::OpenRead($archive)
try { $sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Dispose() }
$root = Join-Path (Split-Path -Parent $installDir) ('.' + (Split-Path -Leaf $installDir) + '.update')
$common = @('--root', "`"$root`"", '--install', "`"$installDir`"", '--exe', "`"$appName`"", '--version', $version)
$log = { if (Test-Path -LiteralPath (Join-Path $root 'update.log')) { Get-Content -LiteralPath (Join-Path $root 'update.log') | Write-Host } }
$marker = Join-Path $installDir 'from-the-installer.txt'
Set-Content -LiteralPath $marker -Value 'replaced by the swap'
# The helper works in no folder but the one beside the installation that is named after it, and says so before it
# writes anything; and nothing is staged before it has staged.
$elsewhere = Join-Path (Split-Path -Parent $installDir) 'varia-staged-elsewhere'
$code = Invoke-Helper $helper @('stage', '--archive', "`"$archive`"", '--sha512', $sha512, '--root', "`"$elsewhere`"", '--install', "`"$installDir`"", '--exe', "`"$appName`"", '--version', $version)
if ($code -ne 2 -or (Test-Path -LiteralPath $elsewhere)) { throw "The helper did not refuse another folder: $code" }
$code = Invoke-Helper $helper (@('check', '--sha512', $sha512) + $common)
if ($code -ne 3) { throw "The helper took a release for staged before staging: $code" }
$code = Invoke-Helper $helper (@('stage', '--archive', "`"$archive`"", '--sha512', $sha512) + $common)
if ($code -ne 0) { & $log; throw "Staging failed: $code" }
# What main asks before it offers Restart to Update, and again when that is chosen.
$code = Invoke-Helper $helper (@('check', '--sha512', $sha512) + $common)
if ($code -ne 0) { & $log; throw "The helper does not take the release it staged for staged: $code" }
# Made for this user alone: its access rules are its own, not the parent folder's.
if (-not (Get-Acl -LiteralPath $root).AreAccessRulesProtected) { throw 'The staging folder inherits its access rules.' }
$staged = Join-Path $root 'app'
foreach ($name in @($appName, "Uninstall $appName", 'resources\app.asar', 'resources\updater\Varia.Updater.exe', 'resources\backend\Varia.Backend.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $staged $name) -PathType Leaf)) { throw "The staged release lacks $name." }
}
if ((Get-Content -LiteralPath (Join-Path $root 'staged.json') | ConvertFrom-Json).version -ne $version) { throw 'The staged marker does not name the version.' }
if (-not (Test-Path -LiteralPath $marker)) { throw 'Staging changed the installation.' }
$swapper = Join-Path $root 'Varia.Updater.exe'
Copy-Item -LiteralPath $helper -Destination $swapper
$code = Invoke-Helper $swapper (@('swap', '--pid', '0', '--from', $version, '--no-start') + $common)
if ($code -ne 0) { & $log; throw "The swap failed: $code" }
if (Test-Path -LiteralPath $marker) { throw 'The swap left the old installation in place.' }
# Every file of the packaged application is in the installation, at its size: what 7-Zip archived is what the helper
# unpacked. Setup's additions (the uninstaller, the elevation helper) came across from the installation it replaced.
function Assert-Application($what) {
  $unpacked = (Resolve-Path 'dist/win-unpacked').Path
  $files = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File)
  if ($files.Count -lt 50) { throw "dist/win-unpacked holds only $($files.Count) files." }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($unpacked.Length + 1)
    $installed = Get-Item -LiteralPath (Join-Path $installDir $relative) -ErrorAction SilentlyContinue
    if ($null -eq $installed -or $installed.Length -ne $file.Length) { throw "The $what installation's $relative is missing or not the packaged file's size." }
  }
  foreach ($name in @($appName, "Uninstall $appName", 'resources\elevate.exe', 'resources\updater\Varia.Updater.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir $name) -PathType Leaf)) { throw "The $what installation lacks $name." }
  }
}
Assert-Application 'swapped'
if ((Test-Path -LiteralPath $staged) -or (Test-Path -LiteralPath (Join-Path $root 'old')) -or (Test-Path -LiteralPath (Join-Path $root 'staged.json')) -or (Test-Path -LiteralPath (Join-Path $root 'failed.json')) -or (Test-Path -LiteralPath (Join-Path $root 'swap.json'))) { throw 'The swap left staged or old files, or its journal, behind.' }
if ($null -ne (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -ErrorAction SilentlyContinue).VariaSqlManagerUpdate) { throw 'The swap left its sign-in recovery registered.' }
# A swap cut short between its renames (the power went): the sign-in recovery puts the staged release in place.
$code = Invoke-Helper $helper (@('stage', '--archive', "`"$archive`"", '--sha512', $sha512) + $common)
if ($code -ne 0) { & $log; throw "Staging again failed: $code" }
Copy-Item -LiteralPath $helper -Destination $swapper -Force
# A scanner may still be reading what the swap just put there, and Windows renames no folder with a file open.
$deadline = (Get-Date).AddSeconds(60)
while ($true) {
  try { Move-Item -LiteralPath $installDir -Destination (Join-Path $root 'old'); break }
  catch [System.IO.IOException], [System.UnauthorizedAccessException] { if ((Get-Date) -ge $deadline) { throw }; Start-Sleep -Milliseconds 250 }
}
Set-Content -LiteralPath (Join-Path $root 'swap.json') -Value (@{ installDir = $installDir; exe = $appName; version = $version; from = $version } | ConvertTo-Json -Compress)
$process = Start-Process -FilePath $swapper -ArgumentList 'recover' -WorkingDirectory $root -PassThru
if (-not $process.WaitForExit(300000)) { $process.Kill($true); throw 'The recovery timed out.' }
if ($process.ExitCode -ne 0) { & $log; throw "The recovery failed: $($process.ExitCode)" }
Assert-Application 'recovered'
if ((Test-Path -LiteralPath (Join-Path $root 'old')) -or (Test-Path -LiteralPath (Join-Path $root 'swap.json'))) { throw 'The recovery left the old version or its journal behind.' }
Write-Host 'Staged update: the installed helper unpacked this build beside the installation, swapped it in, and finished an interrupted swap.'

# Uninstalling takes a staged release with it: Setup's uninstaller has the installation's helper remove the staging
# folder before it removes the application (build/installer.nsh). Run in place (_?=, which must come last, unquoted), so
# that it can be waited for.
$code = Invoke-Helper $helper (@('stage', '--archive', "`"$archive`"", '--sha512', $sha512) + $common)
if ($code -ne 0) { & $log; throw "Staging before the uninstall failed: $code" }
if (-not (Test-Path -LiteralPath (Join-Path $staged $appName) -PathType Leaf)) { throw 'Nothing was staged before the uninstall.' }
$process = Start-Process -FilePath (Join-Path $installDir "Uninstall $appName") -ArgumentList @('/S', '/currentuser', "_?=$installDir") -PassThru
if (-not $process.WaitForExit(180000)) { $process.Kill($true); throw 'The uninstaller timed out.' }
if ($process.ExitCode -ne 0) { throw "The uninstaller failed: $($process.ExitCode)" }
if (Test-Path -LiteralPath $exe) { throw 'The uninstaller left the application.' }
if (Test-Path -LiteralPath $root) { throw 'The uninstaller left the staging folder beside where the installation was.' }
Write-Host 'Uninstall: the application and the release staged beside it are both gone.'
