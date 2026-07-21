# agent-cli-bridge installer — Windows (PowerShell 5+).
#
# What this script does (nothing else):
#   1. Looks for Node.js >= 20 on your PATH; if absent, downloads a private
#      copy of the Node 22 LTS runtime into %USERPROFILE%\.agent-cli-bridge\node
#      (checksum-verified; your system and any existing Node stay untouched).
#   2. Downloads the latest agent-cli-bridge release (two readable JS files)
#      from github.com — the same files you can inspect on the Releases page.
#   3. Writes an agent-cli-bridge.cmd launcher and adds the install dir to
#      your *user* PATH.
#
# Uninstall: remove %USERPROFILE%\.agent-cli-bridge and that PATH entry.
$ErrorActionPreference = "Stop"

$Repo = if ($env:AGENT_CLI_BRIDGE_REPO) { $env:AGENT_CLI_BRIDGE_REPO } else { "moonomat/agent-cli-bridge" }
$InstallDir = if ($env:AGENT_CLI_BRIDGE_HOME) { $env:AGENT_CLI_BRIDGE_HOME } else { Join-Path $env:USERPROFILE ".agent-cli-bridge" }
$ReleaseBase = "https://github.com/$Repo/releases/latest/download"
$NodeDistBase = "https://nodejs.org/dist/latest-v22.x"

function Say($msg) { Write-Host "[agent-cli-bridge] $msg" }
function Fail($msg) { Write-Host "[agent-cli-bridge] ERROR: $msg" -ForegroundColor Red; exit 1 }

# --- 1. Node >= 20: use the system one, or install a private runtime ---------
$NodeBin = $null
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
    $found = (& node -v)
    $major = [int]($found -replace '^v(\d+).*', '$1')
    if ($major -ge 20) {
        $NodeBin = "node"
        Say "Found Node $found on PATH - using it."
    } else {
        Say "Found Node $found - too old (need >= 20), installing a private runtime instead."
    }
}

if (-not $NodeBin) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    Say "Downloading the Node 22 LTS runtime (private copy in $InstallDir\node - does not touch your system)..."
    $shasums = (Invoke-WebRequest -UseBasicParsing "$NodeDistBase/SHASUMS256.txt").Content
    $zipMatch = [regex]::Match($shasums, "node-v[0-9.]+-win-$arch\.zip")
    if (-not $zipMatch.Success) { Fail "No Node build found for win-$arch." }
    $zipName = $zipMatch.Value

    $tmp = Join-Path $env:TEMP "agent-cli-bridge-install"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $zipPath = Join-Path $tmp $zipName
    Invoke-WebRequest -UseBasicParsing "$NodeDistBase/$zipName" -OutFile $zipPath

    Say "Verifying checksum..."
    $expected = ([regex]::Match($shasums, "([0-9a-f]{64})\s+$([regex]::Escape($zipName))")).Groups[1].Value
    $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToLower()
    if ($actual -ne $expected) { Fail "Checksum mismatch for $zipName - aborting." }

    $nodeDir = Join-Path $InstallDir "node"
    if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
    # The zip contains a single node-vX.Y.Z-win-<arch>\ folder; move it into place.
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Move-Item (Join-Path $tmp ($zipName -replace '\.zip$', '')) $nodeDir
    Remove-Item -Recurse -Force $tmp
    $NodeBin = Join-Path $nodeDir "node.exe"
    Say "Node $(& $NodeBin -v) installed."
}

# --- 2. Download the bridge from the latest GitHub release -------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Say "Downloading agent-cli-bridge (latest release of github.com/$Repo)..."
try {
    Invoke-WebRequest -UseBasicParsing "$ReleaseBase/agent-cli-bridge.mjs" -OutFile (Join-Path $InstallDir "agent-cli-bridge.mjs")
} catch {
    Fail "Download failed - does github.com/$Repo have a release yet?"
}
Invoke-WebRequest -UseBasicParsing "$ReleaseBase/mcp-proxy-server.cjs" -OutFile (Join-Path $InstallDir "mcp-proxy-server.cjs")

# --- 3. Launcher + user PATH -------------------------------------------------
$launcher = Join-Path $InstallDir "agent-cli-bridge.cmd"
$nodeCmd = if ($NodeBin -eq "node") { "node" } else { "`"$NodeBin`"" }
Set-Content -Path $launcher -Value "@echo off`r`n$nodeCmd `"$InstallDir\agent-cli-bridge.mjs`" %*"
Say "Launcher written to $launcher"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Say "Added $InstallDir to your user PATH (open a NEW terminal to pick it up)."
}

Say "Installed. Now start it (in a NEW terminal, so the PATH change is picked up):"
Write-Host ""
Write-Host "    agent-cli-bridge"
Write-Host ""
Say "It will print a pairing token - paste that into your app's bridge settings."
