param(
    [string]$Model = 'coding',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$routerUrl = 'http://127.0.0.1:20128'
$nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$codexCandidates = @(
    (Join-Path $env:LOCALAPPDATA '9RouterTools\node_modules\@openai\codex\bin\codex.js'),
    (Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js')
)
$routerCandidates = @(
    (Join-Path $env:LOCALAPPDATA '9RouterTools\node_modules\9router\cli.js'),
    (Join-Path $env:APPDATA 'npm\node_modules\9router\cli.js')
)
$codexCli = $codexCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$routerCli = $routerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!(Test-Path -LiteralPath $nodePath) -or !$codexCli) {
    throw 'Node.js or the packaged Codex CLI is missing. Install Node.js and @openai/codex first.'
}

$configRoot = Join-Path $env:USERPROFILE '.codex'
if ($env:CODEX_HOME) { $configRoot = $env:CODEX_HOME }
$configPath = Join-Path $configRoot 'config.toml'
if (!(Test-Path -LiteralPath $configPath) -or
    !(Select-String -LiteralPath $configPath -Pattern '^\[model_providers\.9router\]' -Quiet)) {
    throw 'Configure the 9router provider in the user Codex config first using 9Router CLI Tools.'
}

try {
    $health = Invoke-RestMethod "$routerUrl/api/health" -TimeoutSec 2
} catch {
    if (!$routerCli) { throw '9Router is unavailable and its CLI package is missing.' }
    $routerArguments = '"' + $routerCli + '" --host 127.0.0.1 --port 20128 --tray --no-browser --skip-update'
    Start-Process -FilePath $nodePath -ArgumentList $routerArguments -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        try { $health = Invoke-RestMethod "$routerUrl/api/health" -TimeoutSec 2 } catch { $health = $null }
    } until ($health.ok -or (Get-Date) -gt $deadline)
}
if (!$health.ok) { throw "9Router did not become ready at $routerUrl." }

$catalog = Invoke-RestMethod "$routerUrl/v1/models" -TimeoutSec 10
if ($Model -notin @($catalog.data.id)) {
    throw "Model or combo '$Model' is unavailable. Check the 9Router dashboard."
}

Write-Host "Project: $projectRoot"
Write-Host "Router:  $routerUrl/v1"
Write-Host "Model:   $Model"
if ($CheckOnly) {
    & $nodePath $codexCli --version
    exit $LASTEXITCODE
}

Set-Location -LiteralPath $projectRoot
& $nodePath $codexCli --cd $projectRoot --model $Model --config 'model_provider="9router"'
exit $LASTEXITCODE
