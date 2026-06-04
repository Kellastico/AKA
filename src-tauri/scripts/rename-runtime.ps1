# Build the aka-runtime sidecar and copy the binary into src-tauri\binaries\
# with the Tauri-required `<name>-<target-triple>.exe` suffix.
#
# Usage:
#   scripts\rename-runtime.ps1                          # host triple
#   scripts\rename-runtime.ps1 x86_64-pc-windows-msvc   # explicit triple
[CmdletBinding()]
param([string]$Triple)

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$TauriDir   = Resolve-Path (Join-Path $ScriptDir "..")
$RuntimeDir = Join-Path $TauriDir "aka-runtime"
$BinDir     = Join-Path $TauriDir "binaries"

$HostTriple = (& rustc -vV | Select-String '^host:').ToString().Split(' ')[1]
if (-not $Triple) { $Triple = $HostTriple }

Write-Host "Building aka-runtime for $Triple ..."
Push-Location $RuntimeDir
try {
  if ($Triple -ne $HostTriple) {
    cargo build --release --target $Triple
    $Src = Join-Path $RuntimeDir "target\$Triple\release\aka-runtime.exe"
  } else {
    cargo build --release
    $Src = Join-Path $RuntimeDir "target\release\aka-runtime.exe"
  }
} finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Dest = Join-Path $BinDir "aka-runtime-$Triple.exe"
Copy-Item -Force $Src $Dest
Write-Host "Copied -> $Dest"
