$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$version = (Get-Content package.json | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/Varia-SQL-Manager-$version-Windows-x64-Setup.exe").Path
# Only run this on an ephemeral CI runner: the silent checks create an actual per-user installation and shortcuts.
if ($env:CI -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or -not $env:RUNNER_TEMP) { throw 'Installer smoke tests require a GitHub-hosted runner.' }
$installDir = Join-Path $env:RUNNER_TEMP ('varia-install-' + [guid]::NewGuid().ToString('N'))
$exe = Join-Path $installDir 'Varia SQL Manager.exe'

function Wait-Window($process) {
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    $process.Refresh()
    if ($process.HasExited) { throw "Installer exited before displaying its wizard: $($process.ExitCode)" }
    if ($process.MainWindowHandle -ne 0) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      if ($window) { return $window }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'Installer did not display a wizard.'
}
function Find-Controls($window, $type) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
  return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Find-Button($process, $name) {
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $window = Wait-Window $process
    $buttons = @(Find-Controls $window ([System.Windows.Automation.ControlType]::Button))
    foreach ($button in $buttons) {
      if ($button.Current.Name.Replace('&', '') -match $name) { return $button }
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $names = @($buttons | ForEach-Object { $_.Current.Name }) -join ', '
  throw "Installer button not found: $name; available buttons: $names"
}
function Invoke-Button($button) {
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

# The first wizard page must appear even for --updated and lookalike flags; no app may be installed yet.
foreach ($flag in @('', '--updated', '--silent-extra')) {
  $arguments = @()
  if ($flag) { $arguments += $flag }
  $arguments += "/D=$installDir"
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru
  try {
    $window = Wait-Window $process
    if (Test-Path -LiteralPath $exe) { throw "Installer wrote application files before confirmation ($flag)." }
    $next = Find-Button $process '^Next'
    if (-not $flag) {
      Invoke-Button $next
      $deadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $radios = @(Find-Controls $window ([System.Windows.Automation.ControlType]::RadioButton))
      } while ($radios.Count -lt 2 -and (Get-Date) -lt $deadline)
      $names = @($radios | ForEach-Object { $_.Current.Name })
      if (-not ($names -match 'all users') -or -not ($names -match 'Only for.*me')) { throw "Missing user and all-users choices: $names" }
      Invoke-Button (Find-Button $process '^Next')
      $deadline = (Get-Date).AddSeconds(15)
      do {
        Start-Sleep -Milliseconds 250
        $buttons = @(Find-Controls $window ([System.Windows.Automation.ControlType]::Button))
        $installButton = @($buttons | Where-Object { $_.Current.Name -match '^Install$' })
      } while (-not $installButton -and (Get-Date) -lt $deadline)
      if (-not $installButton) { throw 'No explicit Install button appeared.' }
      if (Test-Path -LiteralPath $exe) { throw 'Installer wrote application files before Install was clicked.' }
    }
  } finally {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
  }
}

# Exercise both supported unattended flags against an actual per-user install in the runner's temp directory.
foreach ($flag in @('--silent', '/S')) {
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
