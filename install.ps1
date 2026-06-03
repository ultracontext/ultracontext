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
#   UC_VERSION                   - Version to install (default: v1.6.0)
#   UC_INSTALL_DIR               - Custom install directory (default: $HOME\.ultracontext\bin)
#   GITHUB_BASE                  - Custom GitHub base URL (default: https://github.com)
#   ULTRACONTEXT_INSTALL_MUTAGEN - Set to 0 to skip the Mutagen auto-install (uc sync needs it)
#   ULTRACONTEXT_INSTALL_SKILL   - Set to 0 to skip installing the agent skill
#   ULTRACONTEXT_SKILL_TARGETS   - Space-separated agent skills dirs (overrides the defaults)
#   ULTRACONTEXT_MUTAGEN_VERSION - Pin a Mutagen version (default: v0.18.1)

param(
  [string]$Version = $env:UC_VERSION
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Defaults ----------------------------------------------------------------

# Bumped by the release phase — keep this the single source of truth for the tag.
$defaultVersion = 'v1.6.0'

# Mutagen version `uc sync` shells out to. Pinned; verified release asset name.
$defaultMutagenVersion = 'v0.18.1'

# --- Helpers -----------------------------------------------------------------

function Write-Info { param($msg) Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Ok   { param($msg) Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "  warn: $msg" -ForegroundColor Yellow }

function Write-Fail {
  param($msg)
  Write-Host "  error: $msg" -ForegroundColor Red
}

# Download a URL to a file. Returns $true on success, $false on any failure.
function Get-File {
  param($Url, $OutFile)
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

# State shared with the summary block (set by the install functions below).
$script:mutagenState = 'not installed'
$script:skillState   = 'not installed'

# --- Mutagen auto-install ----------------------------------------------------

# `uc sync` shells out to mutagen.exe; install it next to uc.exe (same dir =>
# same PATH) unless opted out or already present. Non-fatal: warns + continues.
function Install-Mutagen {
  param($InstallDir, $GithubBase)

  if ($env:ULTRACONTEXT_INSTALL_MUTAGEN -eq '0') {
    $script:mutagenState = 'skipped (ULTRACONTEXT_INSTALL_MUTAGEN=0)'
    return
  }
  if (Get-Command mutagen -ErrorAction SilentlyContinue) {
    $script:mutagenState = 'on PATH'
    return
  }

  # Verified v0.18.1 Windows asset (note: amd64, and a .zip not a .tar.gz).
  $mv = if ($env:ULTRACONTEXT_MUTAGEN_VERSION) { 'v' + $env:ULTRACONTEXT_MUTAGEN_VERSION.TrimStart('v') } else { $defaultMutagenVersion }
  $asset = "mutagen_windows_amd64_${mv}.zip"
  $url = "$GithubBase/mutagen-io/mutagen/releases/download/$mv/$asset"

  $work = Join-Path ([System.IO.Path]::GetTempPath()) "uc-mutagen-$([System.Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $zip = Join-Path $work $asset
    Write-Info "Downloading Mutagen from $url"
    if (-not (Get-File $url $zip)) {
      Write-Warn "Mutagen download failed -- skipping. uc sync needs it; install manually or rerun."
      $script:mutagenState = 'not installed (download failed)'
      return
    }

    # The zip holds mutagen.exe plus a mutagen-agents.tar.gz sidecar it needs
    # for remote sync -- expand all, then copy both alongside uc.exe.
    Expand-Archive -Path $zip -DestinationPath $work -Force
    $bin = Get-ChildItem -Path $work -Filter 'mutagen.exe' -Recurse | Select-Object -First 1
    if (-not $bin) {
      Write-Warn "mutagen.exe not found in archive -- skipping."
      $script:mutagenState = 'not installed (binary missing)'
      return
    }
    Copy-Item -Path $bin.FullName -Destination (Join-Path $InstallDir 'mutagen.exe') -Force
    $agents = Get-ChildItem -Path $work -Filter 'mutagen-agents.tar.gz' -Recurse | Select-Object -First 1
    if ($agents) { Copy-Item -Path $agents.FullName -Destination (Join-Path $InstallDir 'mutagen-agents.tar.gz') -Force }

    $script:mutagenState = (Join-Path $InstallDir 'mutagen.exe')
    Write-Info "Mutagen $mv installed"
  } catch {
    Write-Warn "Mutagen install failed -- skipping."
    $script:mutagenState = 'not installed (error)'
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

# --- Agent-skill install -----------------------------------------------------

# Copy the bundled skill into each agent's skills dir. The installer has no
# checkout, so the skill travels with the release as ultracontext-skill.tar.gz.
function Install-Skill {
  param($Repo, $VersionTag)

  if ($env:ULTRACONTEXT_INSTALL_SKILL -eq '0') {
    $script:skillState = 'skipped (ULTRACONTEXT_INSTALL_SKILL=0)'
    return
  }

  # Default agent skills dirs (override via ULTRACONTEXT_SKILL_TARGETS).
  $defaults = "$HOME\.claude\skills $HOME\.agents\skills $HOME\.openclaw\skills $HOME\.hermes\skills"
  $targets = ($(if ($env:ULTRACONTEXT_SKILL_TARGETS) { $env:ULTRACONTEXT_SKILL_TARGETS } else { $defaults })) -split '\s+' | Where-Object { $_ -ne '' }

  $url = "$Repo/releases/download/$VersionTag/ultracontext-skill.tar.gz"
  $work = Join-Path ([System.IO.Path]::GetTempPath()) "uc-skill-$([System.Guid]::NewGuid())"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  try {
    $tar = Join-Path $work 'ultracontext-skill.tar.gz'
    Write-Info "Downloading agent skill from $url"
    if (-not (Get-File $url $tar)) {
      Write-Warn "Skill bundle not found in release -- skipping skill install."
      $script:skillState = 'not installed (skill asset missing from release)'
      return
    }

    # tar ships with Windows 10+; expand and locate SKILL.md in the bundle.
    & tar -xzf $tar -C $work 2>$null
    $src = Get-ChildItem -Path $work -Filter 'SKILL.md' -Recurse | Select-Object -First 1
    if (-not $src) {
      Write-Warn "SKILL.md not found in skill bundle -- skipping."
      $script:skillState = 'not installed (SKILL.md missing)'
      return
    }

    $installed = 0
    foreach ($base in $targets) {
      $dst = Join-Path $base 'ultracontext'
      try {
        New-Item -ItemType Directory -Path $dst -Force | Out-Null
        Copy-Item -Path $src.FullName -Destination (Join-Path $dst 'SKILL.md') -Force
        Write-Info "Installed UltraContext skill to $dst"
        $installed++
      } catch { }
    }
    $script:skillState = if ($installed -gt 0) { "$installed agent dir(s)" } else { 'not installed (no writable target dirs)' }
  } catch {
    Write-Warn "Skill install failed -- skipping."
    $script:skillState = 'not installed (error)'
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
}

# --- PATH-conflict warning ---------------------------------------------------

# Warn if another uc resolves on PATH at a different location than ours.
function Warn-PathConflict {
  param($Exe)
  $resolved = Get-Command uc -ErrorAction SilentlyContinue
  if ($resolved -and $resolved.Source -and ($resolved.Source -ne $Exe)) {
    Write-Host ""
    Write-Warn "another 'uc' is ahead on PATH: $($resolved.Source)"
    Write-Info "This UltraContext install lives at $Exe; your shell may use"
    Write-Info "whichever 'uc' appears first in PATH. Check with: Get-Command uc -All"
  }
}

# --- Install summary ---------------------------------------------------------

# Re-state what each step produced in one block.
function Write-Summary {
  param($Exe)
  Write-Host ""
  Write-Host "  UltraContext install summary:" -ForegroundColor White
  Write-Info "  uc       ->  $Exe"
  Write-Info "  mutagen  ->  $script:mutagenState"
  Write-Info "  skill    ->  $script:skillState"
  Write-Host ""
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

# --- Secondary installs (non-fatal) ------------------------------------------

# Mutagen + agent skill are best-effort; each function swallows its own errors
# so a failure here never aborts the core uc install.
Write-Host ""
Install-Mutagen -InstallDir $installDir -GithubBase $githubBase
Install-Skill   -Repo $repo -VersionTag $Version

# --- PATH setup --------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not $userPath) { $userPath = '' }
$pathEntries = $userPath -split ';' | Where-Object { $_ -ne '' }

if ($pathEntries -contains $installDir) {
  # Already on PATH -- print the getting-started line, warn on conflicts, summarize.
  Write-Host ""
  Write-Host "  Run " -NoNewline
  Write-Host "uc --help" -ForegroundColor Cyan -NoNewline
  Write-Host " to get started"
  Warn-PathConflict -Exe $exe
  Write-Summary -Exe $exe
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

# Flag any other uc ahead on PATH, then re-state the full result in one block.
Warn-PathConflict -Exe $exe
Write-Summary -Exe $exe
return
