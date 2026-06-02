#!/usr/bin/env pwsh
# UltraContext CLI installer for Windows
#
# Usage (PowerShell):
#   irm https://ultracontext.com/install.ps1 | iex
#
# Pin a version:
#   $env:UC_VERSION = 'v1.6.0'; irm https://ultracontext.com/install.ps1 | iex
#
# Environment variables:
#   UC_VERSION      - Version to install (default: v1.6.0)
#   UC_INSTALL_DIR  - Custom install directory (default: $HOME\.ultracontext\bin)
#   GITHUB_BASE     - Custom GitHub base URL (default: https://github.com)

param(
  [string]$Version = $env:UC_VERSION
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Defaults ----------------------------------------------------------------

$defaultVersion = 'v1.6.0'

# --- Helpers -----------------------------------------------------------------

function Write-Info { param($msg) Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok   { param($msg) Write-Host "  $msg" -ForegroundColor Green }

function Write-Fail {
  param($msg)
  Write-Host "  error: $msg" -ForegroundColor Red
}

# --- Architecture detection --------------------------------------------------

if ($env:PROCESSOR_ARCHITECTURE -notin @('AMD64', 'EM64T')) {
  Write-Fail "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE`n`n  UltraContext CLI currently supports Windows x64 only."
  throw "Installation failed."
}

# --- Version + Download URL --------------------------------------------------

# GitHub base, validated as HTTPS to prevent download from arbitrary sources
$githubBase = if ($env:GITHUB_BASE) { $env:GITHUB_BASE } else { 'https://github.com' }
if ($githubBase -notmatch '^https://') {
  Write-Fail "GITHUB_BASE must start with https:// (got: $githubBase)"
  throw "Installation failed."
}

$repo   = "$githubBase/ultracontext/ultracontext"
$target = 'uc-windows-x64.exe'

# version precedence: -Version / $env:UC_VERSION > default
if (-not $Version) { $Version = $defaultVersion }

# normalize to a 'v'-prefixed tag, validating the semver shape
$Version = 'v' + $Version.TrimStart('v')
if ($Version.TrimStart('v') -notmatch '^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$') {
  Write-Fail "Invalid version format: $Version`n`n  Expected: semantic version like 1.6.0 or 1.6.0-beta.1`n  Usage:    `$env:UC_VERSION = 'v1.6.0'; irm https://ultracontext.com/install.ps1 | iex"
  throw "Installation failed."
}

$url = "$repo/releases/download/$Version/$target"

# --- Install directory -------------------------------------------------------

if ($env:UC_INSTALL_DIR) { $installDir = $env:UC_INSTALL_DIR } else { $installDir = Join-Path $HOME '.ultracontext\bin' }
$exe = Join-Path $installDir 'uc.exe'

if (-not (Test-Path $installDir)) {
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# --- Download ----------------------------------------------------------------

Write-Host ""
Write-Host "  Installing UltraContext CLI..." -ForegroundColor White
Write-Host ""
Write-Info "Downloading from $url"
Write-Host ""

# download to a temp file first; only move into place once it's complete
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "ultracontext-$([System.Guid]::NewGuid())"
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$tmpExe = Join-Path $tmpDir 'uc.exe'

try {
  try {
    # Force TLS 1.2 for Windows PowerShell 5.1 (no-op on PowerShell 7+ where it is the default)
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is ~10x faster without the progress bar
    Invoke-WebRequest -Uri $url -OutFile $tmpExe -UseBasicParsing
  } catch {
    Write-Fail "Download failed.`n`n  Possible causes:`n    - No internet connection`n    - The version does not exist: $Version`n    - GitHub is unreachable`n`n  URL: $url"
    throw "Installation failed."
  }

  if (-not (Test-Path $tmpExe)) {
    Write-Fail "Binary not found after download. The download may be corrupted -- try again."
    throw "Installation failed."
  }

  # move the verified binary into the final location
  Move-Item -Path $tmpExe -Destination $exe -Force
} finally {
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}

# --- Verify installation -----------------------------------------------------

try {
  $installedVersion = (& $exe version 2>$null | Out-String).Trim()
} catch {
  $installedVersion = 'unknown'
}

Write-Host ""
Write-Ok "UltraContext CLI $installedVersion installed successfully!"
Write-Host ""
Write-Info "Binary:  $exe"

# --- PATH setup --------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath) { $userPath = '' }
$pathEntries = $userPath -split ';' | Where-Object { $_ -ne '' }

if ($pathEntries -contains $installDir) {
  # Already on PATH -- just print the getting-started line
  Write-Host ""
  Write-Host "  Run " -NoNewline
  Write-Host "uc --help" -ForegroundColor Cyan -NoNewline
  Write-Host " to get started"
  Write-Host ""
  return
}

# Add to user PATH (persists across sessions -- no admin rights needed)
$newPath = ($pathEntries + $installDir) -join ';'
[Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
$env:PATH = "$env:PATH;$installDir"  # Also update the current session

Write-Info "Added $installDir to PATH (User scope)"
Write-Host ""
Write-Info "Restart your terminal, then:"
Write-Host ""
Write-Info "Next steps:"
Write-Host ""
Write-Host "    uc init" -ForegroundColor Cyan
Write-Host "    uc --help" -ForegroundColor Cyan
Write-Host ""
return
