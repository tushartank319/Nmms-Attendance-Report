$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node -ErrorAction SilentlyContinue).Source

if (-not $node) {
    $node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}

if (-not (Test-Path $node)) {
    throw "Node.js was not found. Install Node.js 20 or newer, then run this script again."
}

Set-Location $workspace
Write-Host "Starting NMMS Attendance Shortcut..." -ForegroundColor Green
$url = "http://127.0.0.1:4173"

try {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
    $alreadyRunning = $true
} catch {
    $alreadyRunning = $false
}

if (-not $alreadyRunning) {
    Start-Process -FilePath $node -ArgumentList "server.mjs" -WorkingDirectory $workspace -WindowStyle Hidden | Out-Null

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 300
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 | Out-Null
            $alreadyRunning = $true
            break
        } catch {}
    }
}

if (-not $alreadyRunning) {
    throw "The website could not be started."
}

Write-Host "Opening $url in your default browser..." -ForegroundColor Green
Start-Process $url
