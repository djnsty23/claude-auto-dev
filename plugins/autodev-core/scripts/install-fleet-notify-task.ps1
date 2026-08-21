# install-fleet-notify-task.ps1 — give the fleet notifier a permanent host.
#
# Three decisions worth knowing, because each was arrived at the hard way:
#
# 1. schtasks.exe, NOT Register-ScheduledTask. The PowerShell cmdlet returns
#    "Access is denied" (HRESULT 0x80070005) unelevated on this machine, with or
#    without an explicit -Principal. schtasks creates the same task as the
#    current user without elevation.
#
# 2. THE TASK RUNS INTERACTIVELY. schtasks defaults to "Interactive only", which
#    is required rather than convenient: a task running detached from the desktop
#    session raises toasts that reach nobody.
#
# 3. IT POINTS AT THE CLONE, NOT THE INSTALLED PLUGIN. The installed copy lives
#    under a VERSION-KEYED cache path (…/autodev-core/8.98.0/scripts/…), so a
#    task wired to it silently breaks on the next release. The clone path is
#    stable and is the source of truth.
#
# Verify it is doing the WORK, not merely launching:
#   Get-Content "$env:USERPROFILE\.claude\fleet\.notify-last-run.json"
# Task Scheduler's "Last Result: 0" reports that wscript started, not that the
# scan ran — the marker is the artifact that distinguishes them.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-fleet-notify-task.ps1
#   powershell -ExecutionPolicy Bypass -File install-fleet-notify-task.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File install-fleet-notify-task.ps1 -IntervalMinutes 5

param(
    [int]$IntervalMinutes = 2,
    [string]$ScriptRoot = "$env:USERPROFILE\claude-auto-dev\plugins\autodev-core\scripts",
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AutodevFleetNotify'

if ($Remove) {
    schtasks.exe /Delete /TN $TaskName /F
    exit $LASTEXITCODE
}

$node = (Get-Command node -ErrorAction Stop).Source
$notify = Join-Path $ScriptRoot 'fleet-notify.js'
$vbs = Join-Path $ScriptRoot 'fleet-notify-hidden.vbs'

foreach ($p in @($notify, $vbs)) {
    if (-not (Test-Path $p)) { throw "missing required file: $p" }
}

# wscript with the .vbs wrapper keeps the console window hidden. Running node
# directly flashes a window at the user every $IntervalMinutes minutes.
#
# The /TR value contains quoted paths, and PowerShell 5.1 mangles inner quotes
# when handing a string to a native exe — the first version of this script
# created the task fine from bash and failed from PowerShell for exactly that
# reason. Escaping each inner quote as \" is what actually survives the handoff.
$q = '\"'
$run = 'wscript.exe {0}{1}{0} {0}{2}{0} {0}{3}{0}' -f $q, $vbs, $node, $notify

schtasks.exe /Create /TN $TaskName /TR $run /SC MINUTE /MO $IntervalMinutes /F
if ($LASTEXITCODE -ne 0) { throw "schtasks failed with exit code $LASTEXITCODE" }

Write-Output ''
Write-Output ("registered {0} - every {1} min, interactive, hidden" -f $TaskName, $IntervalMinutes)
Write-Output ("  runs: {0}" -f $run)
Write-Output '  verify the WORK ran (not just the launcher):'
Write-Output '    Get-Content "$env:USERPROFILE\.claude\fleet\.notify-last-run.json"'
