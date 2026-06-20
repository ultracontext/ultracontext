#!/usr/bin/env bash
set -euo pipefail

repo="${UC_REPO:-https://github.com/ultracontext/ultracontext}"
version="${UC_VERSION:-latest}"
install_dir="${UC_INSTALL_DIR:-}"
skip_init="${UC_SKIP_INIT:-0}"

say() {
  printf '%s\n' "$*"
}

fail() {
  say "error: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

path_contains() {
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

default_install_dir() {
  if [ -n "$install_dir" ]; then
    say "$install_dir"
    return
  fi

  if existing="$(command -v uc 2>/dev/null)"; then
    case "$existing" in
      "$HOME"/*)
        dirname "$existing"
        return
        ;;
    esac
  fi

  if path_contains "$HOME/.local/bin"; then
    say "$HOME/.local/bin"
  elif path_contains "$HOME/.cargo/bin"; then
    say "$HOME/.cargo/bin"
  else
    say "$HOME/.local/bin"
  fi
}

target_triple() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os_part="apple-darwin" ;;
    Linux) os_part="unknown-linux-gnu" ;;
    *) fail "unsupported OS: $os" ;;
  esac

  case "$arch" in
    arm64 | aarch64) arch_part="aarch64" ;;
    x86_64 | amd64) arch_part="x86_64" ;;
    *) fail "unsupported architecture: $arch" ;;
  esac

  say "${arch_part}-${os_part}"
}

release_url() {
  target="$1"
  if [ "$version" = "latest" ]; then
    say "${repo}/releases/latest/download/uc-${target}.tar.gz"
  else
    say "${repo}/releases/download/${version}/uc-${target}.tar.gz"
  fi
}

install_from_release() {
  dir="$1"
  target="$(target_triple)"
  url="$(release_url "$target")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  say "Downloading $url"
  if ! curl -fsSL "$url" -o "$tmp/uc.tar.gz"; then
    return 1
  fi

  tar -xzf "$tmp/uc.tar.gz" -C "$tmp"
  bin="$(find "$tmp" -type f -name uc | head -n 1)"
  [ -n "$bin" ] || fail "release archive did not contain uc"

  mkdir -p "$dir"
  install -m 755 "$bin" "$dir/uc"
  install -m 755 "$bin" "$dir/ultracontext"
}

install_from_source() {
  need cargo
  say "Installing from source with cargo"
  cargo install --git "$repo" ultracontext-cli --locked --force
}

init_global() {
  uc_bin="${1:-}"
  [ "$skip_init" = "1" ] && return 0

  if [ -z "$uc_bin" ] || [ ! -x "$uc_bin" ]; then
    uc_bin="$(command -v uc 2>/dev/null || true)"
  fi

  if [ -z "$uc_bin" ]; then
    say "Skipped global init; uc is not on PATH yet"
    return 0
  fi

  if "$uc_bin" init --global >/dev/null 2>&1; then
    say "Initialized global UltraContext store"
  else
    say "Skipped global init; run 'uc init --global' manually if needed"
  fi
}

main() {
  need curl
  need uname

  dir="$(default_install_dir)"
  uc_bin=""

  if install_from_release "$dir"; then
    uc_bin="$dir/uc"
    say "Installed uc to $dir/uc"
    case ":${PATH:-}:" in
      *":$dir:"*) ;;
      *) say "Add $dir to PATH to use uc from any shell" ;;
    esac
  else
    say "No release binary found; falling back to source install"
    install_from_source
    if [ -x "$HOME/.cargo/bin/uc" ]; then
      uc_bin="$HOME/.cargo/bin/uc"
    fi
  fi

  init_global "$uc_bin"
  say "Done"
}

main "$@"
