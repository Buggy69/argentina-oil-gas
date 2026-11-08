# Register (or re-register) the weekly portal relay as a Windows scheduled task.
#
# Runs as the logged-in user, only while that user is logged on — so no stored
# password and no admin rights, and git can use the credentials already in the
# Windows credential manager.
#
# Thursday 12:00 local. If the laptop is off or asleep then, StartWhenAvailable
# runs it at the next opportunity, so a missed week catches up instead of
# being skipped. The exact day hardly matters: the push it makes triggers the
# cloud refresh straight away, independent of the Friday schedule.
#
# Run once:    powershell -NoProfile -ExecutionPolicy Bypass -File tools\register_relay_task.ps1
# Remove:      Unregister-ScheduledTask -TaskName 'PetroDB portal relay' -Confirm:$false

$Script = Join-Path $PSScriptRoot 'relay_portal_snapshot.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At '12:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'PetroDB portal relay' -Force `
    -Description 'Downloads datos.energia.gob.ar files and pushes data/portal_snapshot to Buggy69/argentina-oil-gas (the portal blocks GitHub runners).' `
    -Action $action -Trigger $trigger -Settings $settings | Out-Null

Get-ScheduledTask -TaskName 'PetroDB portal relay' | Get-ScheduledTaskInfo |
    Select-Object TaskName, NextRunTime
