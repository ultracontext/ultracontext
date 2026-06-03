#!/usr/bin/env bash
# UltraContext CLI installer
#
# Usage:
#   curl -fsSL https://ultracontext.com/install.sh | bash
#   curl -fsSL https://ultracontext.com/install.sh | bash -s v1.6.0
#
# Environment variables:
#   UC_VERSION                   - Version to install (default: v1.6.0)
#   UC_INSTALL_DIR               - Custom install directory (default: ~/.ultracontext/bin)
#   GITHUB_BASE                  - Custom GitHub base URL (default: https://github.com)
#   ULTRACONTEXT_INSTALL_MUTAGEN - Set to 0 to skip the Mutagen auto-install (uc sync needs it)
#   ULTRACONTEXT_INSTALL_SKILL   - Set to 0 to skip installing the agent skill
#   ULTRACONTEXT_SKILL_TARGETS   - Space-separated agent skills dirs (overrides the defaults)
#   ULTRACONTEXT_MUTAGEN_VERSION - Pin a Mutagen version (default: v0.18.1)

# Wrap everything in a function to protect against partial download.
# If the connection drops mid-transfer, bash won't execute a truncated script.
main() {

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────

# Bumped by the release phase — keep this the single source of truth for the tag.
DEFAULT_VERSION="v1.6.0"

# Mutagen version `uc sync` shells out to. Pinned; verified release asset names.
DEFAULT_MUTAGEN_VERSION="v0.18.1"

# ─── Colors (only when outputting to a terminal) ─────────────────────────────

Color_Off='' Red='' Green='' Dim='' Bold='' Blue='' Yellow=''

if [[ -t 1 ]]; then
  Color_Off='\033[0m'
  Red='\033[0;31m'
  Green='\033[0;32m'
  Yellow='\033[0;33m'
  Dim='\033[0;2m'
  Bold='\033[1m'
  Blue='\033[0;34m'
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

error() {
  printf "%b\n" "${Red}error${Color_Off}: $*" >&2
  exit 1
}

warn() {
  printf "%b\n" "${Yellow}warn${Color_Off}: $*" >&2
}

info() {
  printf "%b\n" "${Dim}$*${Color_Off}"
}

success() {
  printf "%b\n" "${Green}$*${Color_Off}"
}

bold() {
  printf "%b\n" "${Bold}$*${Color_Off}"
}

tildify() {
  if [[ $1 == "$HOME"/* ]]; then
    echo "~${1#"$HOME"}"
  else
    echo "$1"
  fi
}

# Download a URL to a file, following redirects. Returns curl's exit status.
fetch() {
  curl --fail --silent --location --output "$1" "$2"
}

# ─── Mutagen auto-install ─────────────────────────────────────────────────────

# `uc sync` shells out to the `mutagen` binary; a clean machine has none.
# Install Mutagen alongside `uc` (same dir → same PATH) unless opted out or
# already present. Non-fatal: any failure warns and leaves the core install OK.
install_mutagen() {
  # Honor the opt-out and skip if mutagen is already resolvable on PATH.
  if [[ ${ULTRACONTEXT_INSTALL_MUTAGEN:-1} == "0" ]]; then
    mutagen_state="skipped (ULTRACONTEXT_INSTALL_MUTAGEN=0)"
    return 0
  fi
  if command -v mutagen >/dev/null 2>&1; then
    mutagen_state="on PATH ($(command -v mutagen))"
    return 0
  fi

  # Map (os, arch) → the verified v0.18.1 release asset (note: amd64, not x64).
  local mutagen_arch
  case "$arch_name" in
    arm64) mutagen_arch=arm64 ;;
    x64)   mutagen_arch=amd64 ;;
  esac
  local mv="${ULTRACONTEXT_MUTAGEN_VERSION:-$DEFAULT_MUTAGEN_VERSION}"
  mv="v${mv#v}"
  local asset="mutagen_${os_name}_${mutagen_arch}_${mv}.tar.gz"
  local m_url="${GITHUB_BASE}/mutagen-io/mutagen/releases/download/${mv}/${asset}"

  # Download + extract into the install dir. The archive holds the `mutagen`
  # binary plus a `mutagen-agents.tar.gz` sidecar it needs for remote sync —
  # extract both so laptop↔VPS sync works out of the box.
  local m_tar="${tmpdir}/${asset}"
  info "  Downloading Mutagen from ${m_url}"
  if ! fetch "$m_tar" "$m_url"; then
    warn "Mutagen download failed — skipping. ${Dim}uc sync needs it; install manually or rerun.${Color_Off}"
    mutagen_state="not installed (download failed)"
    return 0
  fi

  # Pull just the files we ship next to uc (mutagen + its agents bundle).
  if ! tar -xzf "$m_tar" -C "$install_dir" mutagen mutagen-agents.tar.gz 2>/dev/null; then
    # Fall back to extracting the whole archive if the member list ever changes.
    tar -xzf "$m_tar" -C "$install_dir" 2>/dev/null || {
      warn "Mutagen extraction failed — skipping."
      mutagen_state="not installed (extract failed)"
      return 0
    }
  fi

  local m_exe="${install_dir}/mutagen"
  chmod +x "$m_exe" 2>/dev/null || true
  if [[ $os_name == "darwin" ]]; then
    xattr -d com.apple.quarantine "$m_exe" 2>/dev/null || true
  fi

  if [[ -x $m_exe ]]; then
    mutagen_state="$(tildify "$m_exe")"
    info "  Mutagen ${mv} installed"
  else
    mutagen_state="not installed"
  fi
  return 0
}

# ─── Agent-skill install ──────────────────────────────────────────────────────

# Copy the bundled UltraContext skill into each agent's skills dir so agents
# know how to drive `uc`. The installer is curl|bash (no checkout) so the skill
# travels with the release as the `ultracontext-skill.tar.gz` asset. Non-fatal.
install_skill() {
  if [[ ${ULTRACONTEXT_INSTALL_SKILL:-1} == "0" ]]; then
    skill_state="skipped (ULTRACONTEXT_INSTALL_SKILL=0)"
    return 0
  fi

  # Default agent skills dirs (override via ULTRACONTEXT_SKILL_TARGETS).
  local defaults="$HOME/.claude/skills $HOME/.agents/skills $HOME/.openclaw/skills $HOME/.hermes/skills"
  read -r -a targets <<<"${ULTRACONTEXT_SKILL_TARGETS:-$defaults}"

  # Fetch the skill bundle from the release; skip gracefully if it's absent.
  local s_url="${REPO}/releases/download/${VERSION}/ultracontext-skill.tar.gz"
  local s_tar="${tmpdir}/ultracontext-skill.tar.gz"
  local s_dir="${tmpdir}/skill"
  info "  Downloading agent skill from ${s_url}"
  if ! fetch "$s_tar" "$s_url"; then
    warn "Skill bundle not found in release — skipping skill install."
    skill_state="not installed (skill asset missing from release)"
    return 0
  fi

  mkdir -p "$s_dir"
  if ! tar -xzf "$s_tar" -C "$s_dir" 2>/dev/null; then
    warn "Skill bundle could not be extracted — skipping."
    skill_state="not installed (extract failed)"
    return 0
  fi

  # The bundle may be the bare SKILL.md or a skills/ultracontext/ tree — find it.
  local src
  src=$(find "$s_dir" -name SKILL.md -print -quit 2>/dev/null)
  if [[ -z $src ]]; then
    warn "SKILL.md not found in skill bundle — skipping."
    skill_state="not installed (SKILL.md missing)"
    return 0
  fi

  # Install into <target>/ultracontext/ for every configured agent dir.
  local installed=0 base dst
  for base in "${targets[@]}"; do
    dst="${base}/ultracontext"
    if mkdir -p "$dst" 2>/dev/null && cp "$src" "$dst/SKILL.md" 2>/dev/null; then
      info "  Installed UltraContext skill to $(tildify "$dst")"
      installed=$((installed + 1))
    fi
  done

  if [[ $installed -gt 0 ]]; then
    skill_state="${installed} agent dir(s)"
  else
    skill_state="not installed (no writable target dirs)"
  fi
  return 0
}

# ─── PATH-conflict warning ────────────────────────────────────────────────────

# If another `uc` resolves on PATH at a DIFFERENT location than the one we just
# installed, the shell may run whichever appears first — warn the user clearly.
warn_path_conflict() {
  command -v uc >/dev/null 2>&1 || return 0
  local resolved
  resolved=$(command -v uc)
  if [[ $resolved != "$exe" ]]; then
    echo "" >&2
    warn "another 'uc' is ahead on PATH: ${resolved}"
    info "  This UltraContext install lives at $(tildify "$exe"); your shell may"
    info "  use whichever 'uc' appears first in PATH. Check with: command -v uc"
  fi
}

# ─── Install summary ──────────────────────────────────────────────────────────

# Re-state what each step produced in one block so the result is unambiguous.
print_summary() {
  echo ""
  bold "  UltraContext install summary:"
  info  "    uc        ->  $(tildify "$exe")"
  info  "    mutagen   ->  ${mutagen_state:-not installed}"
  info  "    skill     ->  ${skill_state:-not installed}"
  echo ""
}

# ─── Dependency checks ──────────────────────────────────────────────────────

command -v curl >/dev/null 2>&1 || error "curl is required but not found. Install it and try again."

# ─── OS / Architecture detection ────────────────────────────────────────────

# the binary is a single self-contained file — map (os, arch) → uc-<os>-<arch>
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os_name=darwin ;;
  Linux)  os_name=linux ;;
  *)
    error "Unsupported OS: ${os}.

  UltraContext CLI supports:
    - macOS (Apple Silicon / Intel)
    - Linux (x64 / arm64)

  For Windows, run this in PowerShell:
    irm https://ultracontext.com/install.ps1 | iex"
    ;;
esac

case "$arch" in
  arm64 | aarch64)  arch_name=arm64 ;;
  x86_64 | amd64)   arch_name=x64 ;;
  *)
    error "Unsupported architecture: ${arch}.

  UltraContext CLI supports arm64 and x64."
    ;;
esac

target="uc-${os_name}-${arch_name}"

# Detect Rosetta 2 on macOS — prefer the native arm64 binary
if [[ $target == "uc-darwin-x64" ]]; then
  if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0) == "1" ]]; then
    target="uc-darwin-arm64"
    info "  Rosetta 2 detected — installing native arm64 binary"
  fi
fi

# Detect musl (Alpine Linux) — the glibc-linked binary won't run there
if [[ $os_name == "linux" ]]; then
  if ldd --version 2>&1 | grep -qi musl 2>/dev/null; then
    error "Alpine Linux (musl) is not currently supported.

  The compiled binary requires glibc. Use one of these alternatives:
    - npm install -g ultracontext
    - Run in a glibc-based container (e.g., ubuntu, debian)"
  fi
fi

# ─── Version + Download URL ─────────────────────────────────────────────────

GITHUB_BASE=${GITHUB_BASE:-"https://github.com"}

# Validate GITHUB_BASE is HTTPS to prevent download from arbitrary sources
case "$GITHUB_BASE" in
  https://*) ;;
  *) error "GITHUB_BASE must start with https:// (got: ${GITHUB_BASE})" ;;
esac

REPO="${GITHUB_BASE}/ultracontext/ultracontext"

# version precedence: positional arg > $UC_VERSION > default
VERSION="${1:-${UC_VERSION:-$DEFAULT_VERSION}}"

# normalize to a 'v'-prefixed tag, validating the semver shape
VERSION="v${VERSION#v}"
if ! [[ ${VERSION#v} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  error "Invalid version format: ${VERSION}

  Expected: semantic version like 1.6.0 or 1.6.0-beta.1
  Usage:    curl -fsSL https://ultracontext.com/install.sh | bash -s v1.6.0"
fi

url="${REPO}/releases/download/${VERSION}/${target}"

# ─── Install directory ──────────────────────────────────────────────────────

install_dir="${UC_INSTALL_DIR:-$HOME/.ultracontext/bin}"
exe="${install_dir}/uc"

mkdir -p "$install_dir" || error "Failed to create install directory: ${install_dir}"

# ─── Download ────────────────────────────────────────────────────────────────

echo ""
bold "  Installing UltraContext CLI..."
echo ""

tmpdir=$(mktemp -d) || error "Failed to create temporary directory"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

tmpfile="${tmpdir}/uc"

info "  Downloading from ${url}"
echo ""

# download to a temp file first; only move into place once it's complete
curl --fail --location --progress-bar --output "$tmpfile" "$url" ||
  error "Download failed.

  Possible causes:
    - No internet connection
    - The version does not exist: ${VERSION}
    - No binary for this platform: ${target}
    - GitHub is unreachable

  URL: ${url}"

chmod +x "$tmpfile" || error "Failed to make binary executable"

# Strip macOS Gatekeeper quarantine flag (set automatically on curl downloads).
# Without this, macOS blocks the binary: "cannot be opened because Apple cannot
# check it for malicious software."
if [[ $os_name == "darwin" ]]; then
  xattr -d com.apple.quarantine "$tmpfile" 2>/dev/null || true
fi

# atomic-ish install: move the verified binary into the final location
mv -f "$tmpfile" "$exe" || error "Failed to install binary to ${exe}"

# ─── Verify installation ────────────────────────────────────────────────────

installed_version=$("$exe" version 2>/dev/null || echo "unknown")

echo ""
success "  UltraContext CLI ${installed_version} installed successfully!"
echo ""
info "  Binary:  $(tildify "$exe")"

# ─── Secondary installs (non-fatal) ──────────────────────────────────────────

# Mutagen + agent skill are best-effort: calling them in `||` context disables
# errexit inside the bodies, so a failure here never aborts the core uc install.
echo ""
install_mutagen || warn "Mutagen step failed — continuing."
install_skill   || warn "Skill step failed — continuing."

# ─── PATH setup ─────────────────────────────────────────────────────────────

# Track whether PATH already resolves so we can pick the right closing hint,
# but always fall through to the conflict warning + summary (never early-exit).
path_ready=0

# Already on PATH (as our binary, or the dir is present)? Then no rc edit needed.
if command -v uc >/dev/null 2>&1 && [[ "$(command -v uc)" == "$exe" ]]; then
  path_ready=1
elif echo "$PATH" | tr ':' '\n' | grep -qxF "${install_dir}" 2>/dev/null; then
  path_ready=1
fi

# When PATH is already good, just print the getting-started hint and finish.
if [[ $path_ready == 1 ]]; then
  echo ""
  bold "  Run ${Blue}uc --help${Color_Off}${Bold} to get started${Color_Off}"
  warn_path_conflict
  print_summary
  exit 0
fi

# Determine the shell config file to append a PATH export to
shell_name=$(basename "${SHELL:-}")
config=""
shell_line=""

# Build a $HOME-relative path for the shell config (~ doesn't expand in quotes)
if [[ $install_dir == "$HOME"/* ]]; then
  shell_install_dir="\$HOME${install_dir#"$HOME"}"
else
  shell_install_dir="$install_dir"
fi

case $shell_name in
  zsh)
    config="${ZDOTDIR:-$HOME}/.zshrc"
    shell_line="export PATH=\"${shell_install_dir}:\$PATH\""
    ;;
  bash)
    # macOS bash opens login shells — .bash_profile is loaded, not .bashrc.
    # Linux bash opens non-login interactive shells — .bashrc is preferred.
    if [[ $os_name == "darwin" ]]; then
      if [[ -f "$HOME/.bash_profile" ]]; then
        config="$HOME/.bash_profile"
      elif [[ -f "$HOME/.bashrc" ]]; then
        config="$HOME/.bashrc"
      else
        config="$HOME/.bash_profile"
      fi
    else
      if [[ -f "$HOME/.bashrc" ]]; then
        config="$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then
        config="$HOME/.bash_profile"
      else
        config="$HOME/.bashrc"
      fi
    fi
    shell_line="export PATH=\"${shell_install_dir}:\$PATH\""
    ;;
  fish)
    config="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/ultracontext.fish"
    mkdir -p "$(dirname "$config")"
    shell_line="fish_add_path ${shell_install_dir}"
    ;;
esac

if [[ -n $config ]]; then
  # Skip if a PATH entry already exists (check both tildified and absolute)
  if [[ -f "$config" ]] && (grep -qF "$(tildify "$install_dir")" "$config" 2>/dev/null || grep -qF "$install_dir" "$config" 2>/dev/null); then
    info "  PATH already configured in $(tildify "$config")"
  elif [[ -w "${config%/*}" ]] || [[ -w "$config" ]]; then
    {
      echo ""
      echo "# UltraContext CLI"
      echo "$shell_line"
    } >> "$config"
    info "  Added $(tildify "$install_dir") to \$PATH in $(tildify "$config")"
    echo ""
    info "  To start using the UltraContext CLI, run:"
    echo ""
    bold "    source $(tildify "$config")"
    bold "    uc --help"
  else
    echo ""
    info "  Manually add to your shell config:"
    echo ""
    bold "    ${shell_line}"
  fi
else
  echo ""
  info "  Add to your shell config:"
  echo ""
  bold "    export PATH=\"${shell_install_dir}:\$PATH\""
fi

echo ""
info "  Next steps:"
echo ""
bold "    uc init"
bold "    uc --help"

# Flag any other uc ahead on PATH, then re-state the full result in one block.
warn_path_conflict
print_summary

}

# Run the installer — this line MUST be the last line in the file.
# If the download is interrupted, bash will not execute an incomplete function.
main "$@"
