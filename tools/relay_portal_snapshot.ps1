# Weekly relay: fetch the official portal files on THIS machine and push them.
#
# WHY THIS EXISTS
# ---------------
# Since late October 2026 datos.energia.gob.ar drops connections from GitHub's
# cloud runners, but answers an ordinary Argentine connection in seconds. So
# the one step the cloud cannot do runs here instead: download, and if the
# portal published anything new, commit data/portal_snapshot/ and push. That
# push triggers the cloud refresh (refresh.yml listens for changes to that
# folder), which rebuilds and republishes the site as usual.
#
# Registered as the Windows scheduled task "PetroDB portal relay" by
# tools/register_relay_task.ps1. Every run appends one line per outcome to
# data/raw/relay.log (git-ignored, like everything under data/raw).
#
# Run by hand:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\relay_portal_snapshot.ps1

# 'Continue', not 'Stop': in Windows PowerShell 5.1 any line a native program
# writes to stderr becomes an error record, and 'Stop' would abort on harmless
# git chatter. Success is judged by each program's exit code instead.
$ErrorActionPreference = 'Continue'

$Repo = Split-Path -Parent $PSScriptRoot
# Full path, never "python" or "conda run": on this machine `conda run -n
# geomech python` silently starts a different interpreter (the Cegal venv).
$Py   = 'C:\Users\mhaas\AppData\Local\anaconda3\envs\geomech\python.exe'
$Git  = 'C:\Users\mhaas\AppData\Local\Programs\Git\cmd\git.exe'
$Log  = Join-Path $Repo 'data\raw\relay.log'

# The download script prints em-dashes; without this a redirected Python
# stdout uses the ANSI codepage and can crash on characters outside it.
$env:PYTHONIOENCODING = 'utf-8'

function Write-Log([string]$msg) {
    $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
    Add-Content -Path $Log -Value $line -Encoding utf8
}

Set-Location $Repo
try {
    Write-Log 'start'

    # Start from what is published: the cloud commits a data refresh every
    # week, so a stale local branch would make our push be rejected.
    & $Git pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed (local changes on main?)' }

    $out = & $Py tools\00_download_portal.py 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "download failed:`n$out" }
    if ($out -match 'portal unreachable') {
        # The script fell back to the existing snapshot, so there is nothing
        # new to push. Reaching this line means this machine is blocked too.
        Write-Log 'portal unreachable from this machine as well - nothing to push'
        return
    }

    # The manifest records the fetch time, so it changes on every run even
    # when the data does not. Only the gzipped files are evidence of new data
    # (they are byte-identical when the content is unchanged), so judge by
    # them and discard a manifest-only change.
    $changed = & $Git status --porcelain -- 'data/portal_snapshot/*.gz'
    if (-not $changed) {
        & $Git checkout -- data/portal_snapshot/_portal_manifest.json
        Write-Log 'portal reached, no new data'
        return
    }

    & $Git add data/portal_snapshot
    & $Git commit --quiet -m "chore: portal snapshot from relay ($(Get-Date -Format yyyy-MM-dd))"
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    & $Git push --quiet
    if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
    Write-Log ("pushed new snapshot: " + (($changed | ForEach-Object { $_.Trim() }) -join ', '))
}
catch {
    Write-Log "ERROR: $_"
    exit 1
}
