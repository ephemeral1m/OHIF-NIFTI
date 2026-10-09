param(
    [ValidateSet('start', 'stop', 'status', 'logs', 'backend', 'frontend')]
    [string]$Action = 'start'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$inputDirectory = Join-Path $projectRoot 'local-data/input'
if (!(Test-Path -LiteralPath $inputDirectory)) {
    New-Item -ItemType Directory -Path $inputDirectory -Force | Out-Null
}
$composePath = Join-Path $PSScriptRoot 'compose.yml'
$composeArgs = @('--context', 'desktop-linux', 'compose', '-f', $composePath)
$sampleCompose = Join-Path $PSScriptRoot 'rex-sample.compose.json'
if (Test-Path -LiteralPath $sampleCompose) { $composeArgs += @('-f', $sampleCompose) }
switch ($Action) {
    'start' { & docker @composeArgs up -d --build }
    'stop' { & docker @composeArgs stop }
    'status' { & docker @composeArgs ps }
    'logs' { & docker @composeArgs logs --tail 60 }
    'backend' { & docker @composeArgs restart backend }
    'frontend' { & docker @composeArgs restart frontend }
}
if ($LASTEXITCODE -ne 0) { throw "Local deployment command failed ($LASTEXITCODE)." }
if ($Action -eq 'start') { Write-Host 'Development entry: http://127.0.0.1:1026/nifti (first dependency installation may take several minutes).' }
