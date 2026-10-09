param([string]$Proxy = '', [int]$MonitorSeconds = 600)

# Run in the user's normal PowerShell/Docker context, never change Docker credentials.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$dockerExe = (Get-Command docker.exe -ErrorAction Stop).Source
$composeExe = Join-Path (Split-Path $dockerExe) 'docker-compose.exe'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $PSScriptRoot "deploy-stability-v1-$stamp.log"

function Invoke-DockerChecked([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue' # Native progress/warnings can use stderr.
        & $dockerExe @Arguments
        $commandExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($commandExit -ne 0) { throw "Docker failed: $($Arguments -join ' ')" }
}
function Invoke-ComposeChecked([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if (Test-Path -LiteralPath $composeExe) {
            & $composeExe @Arguments
        } else {
            & $dockerExe compose @Arguments
        }
        $commandExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($commandExit -ne 0) { throw "Compose failed: $($Arguments -join ' ')" }
}

Start-Transcript -Path $logPath
try {
    Write-Host '[1/5] Checking Docker and saving rollback image tags...'
    Invoke-DockerChecked -Arguments @('info', '--format', '{{.ServerVersion}}')
    $existingImages = @(Invoke-DockerChecked -Arguments @('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'))
    foreach ($imageName in @('monai', 'webapp')) {
        if ($existingImages -contains "${imageName}:latest") {
            Invoke-DockerChecked -Arguments @('image', 'tag', "${imageName}:latest", "${imageName}:pre-stability-v1-$stamp")
            Write-Host "Rollback image: ${imageName}:pre-stability-v1-$stamp"
        }
    }
    $buildArgs = @('build')
    if ($Proxy) {
        foreach ($key in @('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy')) {
            $buildArgs += @('--build-arg', "$key=$Proxy")
        }
    }
    Write-Host '[2/5] Building MONAI and Viewer (existing images are NOT skipped)...'
    Invoke-ComposeChecked -Arguments ($buildArgs + @('monai_sam2', 'ohif_viewer'))
    Write-Host '[3/5] Starting all services...'
    Invoke-ComposeChecked -Arguments @('up', '-d', '--no-build')
    Write-Host '[4/5] Waiting for base API health...'
    $deadline = (Get-Date).AddMinutes(3)
    $ready = $false
    do {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8002/health' -TimeoutSec 5
            $ready = $health.status -eq 'ok'
        } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Seconds 5 }
    } until ($ready -or (Get-Date) -gt $deadline)
    if (-not $ready) { throw 'MONAI base API did not become ready. See docker logs monai_sam2.' }
    $health | ConvertTo-Json -Depth 5 | Write-Host
    foreach ($modelName in @('voxtell', 'sam2', 'medsam2', 'sam3', 'medgemma')) {
        if ($health.models.$modelName.state -ne 'disabled') { throw "Unexpected enabled model: $modelName" }
    }
    Write-Host "[5/5] Monitoring MONAI for $MonitorSeconds seconds; keep this window open..."
    $inspectRaw = & $dockerExe inspect monai_sam2
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect MONAI container' }
    $baseline = ($inspectRaw | ConvertFrom-Json)[0]
    $until = (Get-Date).AddSeconds($MonitorSeconds)
    do {
        Start-Sleep -Seconds 30
        $inspectRaw = & $dockerExe inspect monai_sam2
        if ($LASTEXITCODE -ne 0) { throw 'Could not inspect MONAI container' }
        $current = ($inspectRaw | ConvertFrom-Json)[0]
        if ($current.Id -ne $baseline.Id -or $current.RestartCount -ne $baseline.RestartCount -or $current.State.OOMKilled -or -not $current.State.Running) {
            throw 'MONAI restarted/stopped or was OOM-killed during monitoring'
        }
        $health = Invoke-RestMethod 'http://127.0.0.1:8002/health' -TimeoutSec 10
        Write-Host "$(Get-Date -Format T) API=$($health.status), nnInteractive=$($health.models.nninteractive.state), restarts=$($current.RestartCount)"
    } while ((Get-Date) -lt $until)
    Invoke-ComposeChecked -Arguments @('ps')
    Write-Host 'BASE SERVICE CHECK PASSED. Viewer: http://localhost:1026'
    Write-Host 'Manual acceptance still required: brush save, draft reload/refine, nnInteractive and PACS save.'
} finally {
    Stop-Transcript
    Write-Host "Log: $logPath"
}
