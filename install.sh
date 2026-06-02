#!/usr/bin/env bash
# UltraContext CLI installer
#
# Usage:
#   curl -fsSL https://ultracontext.com/install.sh | bash
#   curl -fsSL https://ultracontext.com/install.sh | bash -s v1.6.0
#
# Environment variables:
#   UC_VERSION      - Version to install (default: v1.6.0)
#   UC_INSTALL_DIR  - Custom install directory (default: ~/.ultracontext/bin)
#   GITHUB_BASE     - Custom GitHub base URL (default: https://github.com)

# Wrap everything in a function to protect against partial download.
# If the connection drops mid-transfer, bash won't execute a truncated script.
main() {

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────

DEFAULT_VERSION="v1.6.0"

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

# ─── PATH setup ─────────────────────────────────────────────────────────────

# Already resolvable as the just-installed binary? Nothing else to do.
if command -v uc >/dev/null 2>&1; then
  existing=$(command -v uc)
  if [[ "$existing" == "$exe" ]]; then
    echo ""
    bold "  Run ${Blue}uc --help${Color_Off}${Bold} to get started${Color_Off}"
    echo ""
    exit 0
  else
    warn "another 'uc' was found at ${existing}"
    info "  The new installation at $(tildify "$exe") may be shadowed."
  fi
fi

# install dir already on PATH? then we're done after a hint.
if echo "$PATH" | tr ':' '\n' | grep -qxF "${install_dir}" 2>/dev/null; then
  echo ""
  bold "  Run ${Blue}uc --help${Color_Off}${Bold} to get started${Color_Off}"
  echo ""
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
echo ""

}

# Run the installer — this line MUST be the last line in the file.
# If the download is interrupted, bash will not execute an incomplete function.
main "$@"
