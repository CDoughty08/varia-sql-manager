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
