param([string]$ClaudePath = $env:CLAUDE_BRIDGE_CLAUDE_PATH)
$ErrorActionPreference = 'Stop'
$bridgeDir = if ($env:CLAUDE_BRIDGE_HOME) { $env:CLAUDE_BRIDGE_HOME } else { Join-Path $HOME '.claude-reviews' }
if ($bridgeDir -match '^~[\\/]') { $bridgeDir = Join-Path $HOME $bridgeDir.Substring(2) }
$previousConfig = $env:CLAUDE_CONFIG_DIR
$previousNesting = $env:CLAUDECODE
$previousEntrypoint = $env:CLAUDE_CODE_ENTRYPOINT
try {
    Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue
    Remove-Item Env:CLAUDE_CODE_ENTRYPOINT -ErrorAction SilentlyContinue
    # The bridge's doctor performs canonical-path isolation checks before login.
    & node (Join-Path $PSScriptRoot '../dist/index.js') --doctor
    if ($LASTEXITCODE -ne 0) { throw 'Bridge preflight failed; login aborted.' }
    $env:CLAUDE_CONFIG_DIR = [IO.Path]::GetFullPath($bridgeDir)
    if (-not $ClaudePath) { $ClaudePath = (Get-Command claude -ErrorAction Stop).Source }
    & $ClaudePath auth login
    if ($LASTEXITCODE -ne 0) { throw 'Claude login failed.' }
} finally {
    $env:CLAUDE_CONFIG_DIR = $previousConfig
    $env:CLAUDECODE = $previousNesting
    $env:CLAUDE_CODE_ENTRYPOINT = $previousEntrypoint
}
