param([string]$ClaudePath = $env:CLAUDE_BRIDGE_CLAUDE_PATH)
$ErrorActionPreference = 'Stop'
$bridgeDir = if ($env:CLAUDE_BRIDGE_HOME) { $env:CLAUDE_BRIDGE_HOME } else { Join-Path $HOME '.claude-reviews' }
if ($bridgeDir -match '^~[\\/]') { $bridgeDir = Join-Path $HOME $bridgeDir.Substring(2) }
$previousConfig = $env:CLAUDE_CONFIG_DIR
try {
    # The bridge's doctor performs canonical-path isolation checks before login.
    & node (Join-Path $PSScriptRoot '../dist/index.js') --doctor
    if ($LASTEXITCODE -ne 0) { throw 'Bridge preflight failed; login aborted.' }
    $env:CLAUDE_CONFIG_DIR = [IO.Path]::GetFullPath($bridgeDir)
    if (-not $ClaudePath) { $ClaudePath = (Get-Command claude -ErrorAction Stop).Source }
    & $ClaudePath auth login
    if ($LASTEXITCODE -ne 0) { throw 'Claude login failed.' }
} finally {
    $env:CLAUDE_CONFIG_DIR = $previousConfig
}
