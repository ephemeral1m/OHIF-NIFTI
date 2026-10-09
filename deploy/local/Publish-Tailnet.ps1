param(
    [ValidateSet('publish', 'status', 'stop')]
    [string]$Action = 'publish',
    [ValidateRange(1, 65535)]
    [int]$Port = 9443
)
$ErrorActionPreference = 'Stop'
$tailscale = (Get-Command tailscale -ErrorAction Stop).Source
if ($Action -eq 'status') {
    & $tailscale serve status
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read Tailscale Serve status.' }
    return
}
if ($Action -eq 'stop') {
    & $tailscale serve "--https=$Port" off
    if ($LASTEXITCODE -ne 0) { throw 'Unable to disable this HTTPS entry.' }
    return
}
$stateJson = & $tailscale status --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read Tailscale status.' }
$state = $stateJson | ConvertFrom-Json
if ($state.BackendState -ne 'Running') { throw 'Connect Tailscale before publishing.' }
$tailnetHostname = $state.Self.DNSName.TrimEnd('.').ToLowerInvariant()
if ($tailnetHostname -notmatch '^[a-z0-9][a-z0-9.-]+\.ts\.net$') { throw 'No valid tailnet DNS hostname found.' }
$existingJson = & $tailscale serve status --json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read existing Serve configuration.' }
$existing = $existingJson | ConvertFrom-Json
if ($existing.TCP -and $existing.TCP.PSObject.Properties.Name -contains "$Port") {
    $entry = $existing.Web.PSObject.Properties["${tailnetHostname}:$Port"].Value
    $rootHandler = if ($entry) { $entry.Handlers.PSObject.Properties['/'].Value } else { $null }
    if (!$rootHandler -or $rootHandler.Proxy -ne 'http://127.0.0.1:1026' -or @($entry.Handlers.PSObject.Properties).Count -ne 1) {
        throw "HTTPS port $Port already serves a different service. Select a free port with -Port."
    }
}
$gateway = Invoke-WebRequest 'http://127.0.0.1:1026/monai/health' -UseBasicParsing -TimeoutSec 10
if ($gateway.StatusCode -ne 200) { throw 'Start the local OHIF deployment first.' }
$configPath = Join-Path $PSScriptRoot 'tailnet.json'
$needsRestart = !(Test-Path -LiteralPath $configPath)
if (!$needsRestart) { $needsRestart = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).hostname -ne $tailnetHostname }
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($configPath, (@{hostname=$tailnetHostname} | ConvertTo-Json) + "`n", $utf8)
if ($needsRestart) {
    & docker --context desktop-linux compose -f (Join-Path $PSScriptRoot 'compose.yml') restart frontend
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply frontend hostname configuration.' }
}
& $tailscale serve --bg "--https=$Port" http://127.0.0.1:1026
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Serve could not publish the local gateway.' }
Write-Host "NIfTI: https://${tailnetHostname}:$Port/nifti"
Write-Host "DICOM: https://${tailnetHostname}:$Port/"
Write-Host 'The frontend may briefly compile after restart.'
