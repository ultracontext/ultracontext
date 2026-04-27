#!/usr/bin/env sh
set -eu

# UltraContext installer for macOS and Linux.
# Usage: curl -fsSL https://ultracontext.com/install.sh | sh

REPO="${ULTRACONTEXT_REPO:-ultracontext/ultracontext}"
VERSION="${ULTRACONTEXT_VERSION:-latest}"
INSTALL_DIR="${ULTRACONTEXT_INSTALL_DIR:-$HOME/.local/bin}"
MUTAGEN_VERSION="${ULTRACONTEXT_MUTAGEN_VERSION:-v0.18.1}"
GUM_VERSION="${ULTRACONTEXT_GUM_VERSION:-0.17.0}"
INSTALL_MUTAGEN="${ULTRACONTEXT_INSTALL_MUTAGEN:-1}"
RUN_SETUP="${ULTRACONTEXT_RUN_SETUP:-1}"

DEV_MODE=0
SUMMARY_FAILED=0
WORK_DIR=""
GUM_DIR=""
GUM=""

setup_ui() {
  BOLD=""
  DIM=""
  RESET=""

  if [ -t 2 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    if [ -z "${NO_COLOR:-}" ]; then
      BOLD="$(printf '\033[1m')"
      DIM="$(printf '\033[2m')"
      RESET="$(printf '\033[0m')"
    fi
    if [ "${ULTRACONTEXT_USE_GUM:-1}" != "0" ]; then
      bootstrap_gum || true
    fi
  fi
}

say() {
  printf '%s\n' "$*" >&2
}

info() {
  printf '%s- %s%s\n' "$DIM" "$*" "$RESET" >&2
}

ok() {
  printf '[ok] %s\n' "$*" >&2
}

warn() {
  printf '[warn] %s\n' "$*" >&2
}

die() {
  printf '[error] %s\n' "$*" >&2
  exit 1
}

section() {
  title="$1"
  say ""
  if use_gum; then
    "$GUM" style --bold --margin "1 0 0 0" "$title" >&2
    return
  fi
  printf '%s%s%s\n' "$BOLD" "$title" "$RESET" >&2
}

kv() {
  key="$1"
  value="$2"
  printf '  %s%-14s%s %s\n' "$DIM" "$key:" "$RESET" "$value" >&2
}

banner() {
  say ""
  if use_gum; then
    {
      printf '%s\n' "UltraContext Installer"
      printf '%s\n' "Same context, everywhere."
    } | "$GUM" style --border rounded --padding "1 2" --margin "1 0" >&2
    return
  fi
  printf '%sUltraContext Installer%s\n' "$BOLD" "$RESET" >&2
  printf '%sSame context, everywhere.%s\n' "$DIM" "$RESET" >&2
}

usage() {
  cat <<'EOF'
Usage: sh install.sh [--dev]

Options:
  --dev       Build this checkout and install it through the same installer path.
  -h, --help  Show this help.

Environment:
  ULTRACONTEXT_INSTALL_DIR      Install directory (default: ~/.local/bin)
  ULTRACONTEXT_VERSION          Release tag or "latest" (default: latest)
  ULTRACONTEXT_INSTALL_MUTAGEN  Set to 0 to skip Mutagen install
  ULTRACONTEXT_INSTALL_SKILL    Set to 0 to make uc setup skip agent skill install
  ULTRACONTEXT_RUN_SETUP        Set to 0 to skip uc setup after install
  ULTRACONTEXT_FORCE            Set to 1 to ignore another install on PATH
  ULTRACONTEXT_USE_GUM          Set to 0 to force plain text UI
EOF
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --dev)
        DEV_MODE=1
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $arg"
        ;;
    esac
  done
}

has() {
  command -v "$1" >/dev/null 2>&1
}

use_gum() {
  [ -n "$GUM" ]
}

raw_download() {
  url="$1"
  out="$2"

  if has curl; then
    curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused "$url" -o "$out"
    return
  fi

  if has wget; then
    wget -q --tries=3 --timeout=20 -O "$out" "$url"
    return
  fi

  return 1
}

sha256_file() {
  file="$1"

  if has sha256sum; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi

  if has shasum; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi

  return 1
}

verify_gum_checksum() {
  checksums="$1"
  archive="$2"
  asset="$3"

  expected="$(awk -v asset="$asset" '$2 == asset {print $1}' "$checksums" | head -n 1)"
  [ -n "$expected" ] || return 1

  actual="$(sha256_file "$archive" 2>/dev/null || true)"
  [ -n "$actual" ] || return 1

  [ "$expected" = "$actual" ]
}

gum_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) gum_os="Darwin" ;;
    Linux) gum_os="Linux" ;;
    *) return 1 ;;
  esac

  case "$arch" in
    arm64|aarch64) gum_arch="arm64" ;;
    x86_64|amd64) gum_arch="x86_64" ;;
    *) return 1 ;;
  esac

  printf '%s %s' "$gum_os" "$gum_arch"
}

bootstrap_gum() {
  if has gum; then
    GUM="$(command -v gum)"
    return
  fi

  has tar || return
  platform="$(gum_platform 2>/dev/null || true)"
  [ -n "$platform" ] || return
  set -- $platform
  gum_os="$1"
  gum_arch="$2"

  GUM_DIR="$(mktemp -d)"
  asset="gum_${GUM_VERSION}_${gum_os}_${gum_arch}.tar.gz"
  base="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}"
  archive="$GUM_DIR/$asset"
  checksums="$GUM_DIR/checksums.txt"

  raw_download "$base/$asset" "$archive" || return
  raw_download "$base/checksums.txt" "$checksums" || return
  verify_gum_checksum "$checksums" "$archive" "$asset" || return

  tar -xzf "$archive" -C "$GUM_DIR" >/dev/null 2>&1 || return
  gum_bin="$(find "$GUM_DIR" -type f -name gum | head -n 1 || true)"
  [ -n "$gum_bin" ] || return
  chmod +x "$gum_bin" >/dev/null 2>&1 || true
  [ -x "$gum_bin" ] || return

  GUM="$gum_bin"
}

run_step() {
  title="$1"
  shift

  if use_gum; then
    "$GUM" spin \
      --spinner dot \
      --spinner.foreground "" \
      --title.foreground "" \
      --title "$title" \
      --show-error \
      -- "$@"
    return
  fi

  info "$title"
  "$@"
}

validate_dev_checkout() {
  [ -f Cargo.toml ] && [ -d skills/ultracontext ] || die "--dev must be run from the UltraContext repository root"
  has cargo || die "cargo is required for --dev"
}

download() {
  url="$1"
  out="$2"
  title="${3:-downloading}"

  if has curl; then
    run_step "$title" curl -fsSL --retry 3 --retry-delay 1 --retry-connrefused "$url" -o "$out"
    return
  fi

  if has wget; then
    run_step "$title" wget -q --tries=3 --timeout=20 -O "$out" "$url"
    return
  fi

  die "curl or wget is required"
}

cleanup() {
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  if [ -n "$GUM_DIR" ] && [ -d "$GUM_DIR" ]; then
    rm -rf "$GUM_DIR"
  fi
}

path_contains() {
  value="$1"
  needle="$2"
  case "$value" in
    *"$needle"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_in_install_dir() {
  path="$1"
  case "$path" in
    "$INSTALL_DIR"/*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_path() {
  path="$1"

  if has realpath; then
    realpath "$path" 2>/dev/null && return
  fi

  target="$(readlink "$path" 2>/dev/null || true)"
  if [ -n "$target" ]; then
    case "$target" in
      /*) printf '%s\n' "$target" ;;
      *) printf '%s/%s\n' "$(dirname "$path")" "$target" ;;
    esac
    return
  fi

  printf '%s\n' "$path"
}

infer_manager_from_path() {
  path="$1"
  resolved="$(resolve_path "$path")"
  combined="$path $resolved"

  if path_contains "$combined" "/node_modules/ultracontext/" || path_contains "$combined" "/npm/native/ultracontext"; then
    printf 'npm'
    return
  fi

  if path_contains "$combined" "/.cargo/bin/"; then
    printf 'cargo'
    return
  fi

  if path_contains "$combined" "/opt/homebrew/Cellar/" || path_contains "$combined" "/usr/local/Cellar/"; then
    printf 'homebrew'
    return
  fi

  printf 'unknown'
}

find_existing_other_install() {
  (command -v uc 2>/dev/null || true; command -v ultracontext 2>/dev/null || true) | while IFS= read -r path; do
    [ -n "$path" ] || continue
    is_in_install_dir "$path" && continue
    printf '%s\n' "$path"
    break
  done
}

delegate_existing_install_if_needed() {
  if [ -x "$INSTALL_DIR/ultracontext" ]; then
    return
  fi

  if [ "${ULTRACONTEXT_FORCE:-0}" = "1" ]; then
    return
  fi

  existing="$(find_existing_other_install)"
  [ -n "$existing" ] || return

  manager="$(infer_manager_from_path "$existing")"
  case "$manager" in
    npm)
      info "existing npm install found: $existing"
      has npm || die "npm install found but npm is not available. Set ULTRACONTEXT_FORCE=1 to install standalone anyway."
      if [ "$DEV_MODE" = "1" ]; then
        die "--dev found an npm install. Remove it or set ULTRACONTEXT_FORCE=1 to test standalone install."
      fi
      info "updating through npm instead of creating a standalone install"
      npm update -g ultracontext
      exit $?
      ;;
    cargo)
      info "existing Cargo install found: $existing"
      has cargo || die "Cargo install found but cargo is not available. Set ULTRACONTEXT_FORCE=1 to install standalone anyway."
      if [ "$DEV_MODE" = "1" ]; then
        validate_dev_checkout
        info "installing this checkout through Cargo instead of creating a standalone install"
        run_step "installing Cargo package" cargo install --path . --force
        ok "install complete"
        run_setup
        exit 0
      else
        info "updating through Cargo instead of creating a standalone install"
        cargo install ultracontext --force
      fi
      exit $?
      ;;
    homebrew)
      info "existing Homebrew install found: $existing"
      has brew || die "Homebrew install found but brew is not available. Set ULTRACONTEXT_FORCE=1 to install standalone anyway."
      if [ "$DEV_MODE" = "1" ]; then
        die "--dev found a Homebrew install. Remove it or set ULTRACONTEXT_FORCE=1 to test standalone install."
      fi
      info "updating through Homebrew instead of creating a standalone install"
      brew upgrade ultracontext
      exit $?
      ;;
    *)
      warn "existing UltraContext install found outside $INSTALL_DIR: $existing"
      die "refusing to create a duplicate install. Set ULTRACONTEXT_FORCE=1 to install standalone anyway."
      ;;
  esac
}

normalize_tag() {
  tag="$1"
  case "$tag" in
    latest) printf '%s' "$tag" ;;
    v*) printf '%s' "$tag" ;;
    *) printf 'v%s' "$tag" ;;
  esac
}

release_url() {
  repo="$1"
  tag="$2"
  asset="$3"

  if [ -n "${ULTRACONTEXT_DOWNLOAD_BASE:-}" ]; then
    printf '%s/%s' "${ULTRACONTEXT_DOWNLOAD_BASE%/}" "$asset"
    return
  fi

  if [ "$tag" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download/%s' "$repo" "$asset"
    return
  fi

  printf 'https://github.com/%s/releases/download/%s/%s' "$repo" "$tag" "$asset"
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)
      UC_OS="apple-darwin"
      MUTAGEN_OS="darwin"
      ;;
    Linux)
      UC_OS="unknown-linux-gnu"
      MUTAGEN_OS="linux"
      ;;
    *)
      die "unsupported OS: $os"
      ;;
  esac

  case "$arch" in
    arm64|aarch64)
      UC_ARCH="aarch64"
      MUTAGEN_ARCH="arm64"
      ;;
    x86_64|amd64)
      UC_ARCH="x86_64"
      MUTAGEN_ARCH="amd64"
      ;;
    *)
      die "unsupported architecture: $arch"
      ;;
  esac

  ULTRACONTEXT_TARGET="${UC_ARCH}-${UC_OS}"
  MUTAGEN_ASSET="mutagen_${MUTAGEN_OS}_${MUTAGEN_ARCH}_${MUTAGEN_VERSION}.tar.gz"
}

show_plan() {
  kv "mode" "$(if [ "$DEV_MODE" = "1" ]; then printf 'dev'; else printf 'release'; fi)"
  kv "version" "$VERSION"
  kv "target" "$ULTRACONTEXT_TARGET"
  kv "install dir" "$INSTALL_DIR"
  kv "mutagen" "$(if [ "$INSTALL_MUTAGEN" = "0" ]; then printf 'skip'; else printf '%s' "$MUTAGEN_VERSION"; fi)"
  kv "setup" "$(if [ "$RUN_SETUP" = "0" ]; then printf 'skip'; else printf 'run'; fi)"
}

prepare_dev_release() {
  if [ "$DEV_MODE" != "1" ]; then
    return
  fi

  validate_dev_checkout

  run_step "building local Rust binary" cargo build

  info "packaging local release archive"
  rm -rf dist/pkg
  mkdir -p dist/pkg
  cp target/debug/ultracontext dist/pkg/ultracontext
  tar -czf "dist/ultracontext-${ULTRACONTEXT_TARGET}.tar.gz" -C dist/pkg ultracontext

  ULTRACONTEXT_DOWNLOAD_BASE="file://$PWD/dist"
  export ULTRACONTEXT_DOWNLOAD_BASE
}

find_extracted_binary() {
  dir="$1"
  name="$2"
  bin="$(find "$dir" -type f -name "$name" | head -n 1 || true)"
  [ -n "$bin" ] || die "could not find $name in downloaded archive"
  printf '%s' "$bin"
}

install_binary() {
  src="$1"
  dst="$2"

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  chmod 0755 "$dst"
}

install_ultracontext() {
  tag="$(normalize_tag "$VERSION")"
  asset="ultracontext-${ULTRACONTEXT_TARGET}.tar.gz"
  url="$(release_url "$REPO" "$tag" "$asset")"
  archive="$WORK_DIR/$asset"
  extract_dir="$WORK_DIR/ultracontext"

  if [ -x "$INSTALL_DIR/ultracontext" ]; then
    current="$("$INSTALL_DIR/ultracontext" version 2>/dev/null || printf 'unknown')"
    info "current: $current"
    info "target:  $tag"
  else
    info "target: $tag"
  fi

  mkdir -p "$extract_dir"
  download "$url" "$archive" "downloading UltraContext"
  tar -xzf "$archive" -C "$extract_dir"

  bin="$(find_extracted_binary "$extract_dir" ultracontext)"
  install_binary "$bin" "$INSTALL_DIR/ultracontext"
  ln -sf "$INSTALL_DIR/ultracontext" "$INSTALL_DIR/uc"

  ok "installed ultracontext: $INSTALL_DIR/ultracontext"
  ok "installed uc: $INSTALL_DIR/uc"
}

install_mutagen() {
  if has mutagen; then
    ok "mutagen already available: $(command -v mutagen)"
    return
  fi

  if [ "$INSTALL_MUTAGEN" = "0" ]; then
    warn "mutagen is missing; skipped by ULTRACONTEXT_INSTALL_MUTAGEN=0"
    return
  fi

  url="https://github.com/mutagen-io/mutagen/releases/download/${MUTAGEN_VERSION}/${MUTAGEN_ASSET}"
  archive="$WORK_DIR/$MUTAGEN_ASSET"
  extract_dir="$WORK_DIR/mutagen"

  mkdir -p "$extract_dir"
  download "$url" "$archive" "downloading Mutagen"
  tar -xzf "$archive" -C "$extract_dir"

  bin="$(find_extracted_binary "$extract_dir" mutagen)"
  install_binary "$bin" "$INSTALL_DIR/mutagen"
  ok "installed mutagen: $INSTALL_DIR/mutagen"
}

status_line() {
  state="$1"
  label="$2"
  detail="$3"

  case "$state" in
    ok)
      marker="[ok]"
      ;;
    miss)
      marker="[!!]"
      SUMMARY_FAILED=1
      ;;
    skip)
      marker="${DIM}[--]${RESET}"
      ;;
    warn)
      marker="[!]"
      ;;
    *)
      marker="[?]"
      ;;
  esac

  printf '  %s %-13s %s\n' "$marker" "$label" "$detail" >&2
}

print_summary() {
  say ""
  printf '%sInstall summary%s\n' "$BOLD" "$RESET" >&2

  if [ -x "$INSTALL_DIR/ultracontext" ]; then
    status_line ok ultracontext "$INSTALL_DIR/ultracontext"
  else
    status_line miss ultracontext "$INSTALL_DIR/ultracontext (not executable)"
  fi

  if [ -L "$INSTALL_DIR/uc" ] || [ -x "$INSTALL_DIR/uc" ]; then
    status_line ok uc "$INSTALL_DIR/uc"
  else
    status_line miss uc "$INSTALL_DIR/uc (missing)"
  fi

  mutagen_path="$(command -v mutagen || true)"
  if [ -n "$mutagen_path" ]; then
    status_line ok mutagen "$mutagen_path"
  elif [ -x "$INSTALL_DIR/mutagen" ]; then
    status_line ok mutagen "$INSTALL_DIR/mutagen"
  elif [ "$INSTALL_MUTAGEN" = "0" ]; then
    status_line skip mutagen "skipped"
  else
    status_line miss mutagen "missing"
  fi

  case ":$PATH:" in
    *":$INSTALL_DIR:"*)
      status_line ok PATH "$INSTALL_DIR is on PATH"
      ;;
    *)
      status_line warn PATH "add to shell profile: export PATH=\"$INSTALL_DIR:\$PATH\""
      ;;
  esac

  say ""
  if [ "$SUMMARY_FAILED" = "1" ]; then
    warn "install completed with errors above"
  else
    ok "install complete"
  fi
}

find_ultracontext_bin() {
  if [ -x "$INSTALL_DIR/ultracontext" ]; then
    printf '%s' "$INSTALL_DIR/ultracontext"
    return
  fi
  command -v ultracontext 2>/dev/null || true
}

has_interactive_tty() {
  if [ -t 0 ]; then
    return 0
  fi
  [ -r /dev/tty ] || return 1
  { : < /dev/tty; } 2>/dev/null
}

run_setup() {
  if [ "$RUN_SETUP" != "1" ]; then
    print_next_step
    return
  fi

  bin="$(find_ultracontext_bin)"
  if [ -z "$bin" ]; then
    warn "could not find ultracontext on PATH"
    print_next_step
    return
  fi

  say ""
  info "starting uc setup"
  if [ -t 0 ]; then
    PATH="$INSTALL_DIR:$PATH" "$bin" setup || warn "uc setup did not complete"
  elif [ -r /dev/tty ]; then
    PATH="$INSTALL_DIR:$PATH" "$bin" setup < /dev/tty || warn "uc setup did not complete"
  else
    warn "no TTY available — run \`uc setup\` manually"
    print_next_step
  fi
}

print_next_step() {
  say ""
  printf '%sNext:%s uc setup\n' "$BOLD" "$RESET" >&2
}

main() {
  trap cleanup EXIT INT TERM
  parse_args "$@"
  setup_ui
  banner

  section "Prepare"
  detect_platform
  show_plan
  delegate_existing_install_if_needed
  prepare_dev_release

  WORK_DIR="$(mktemp -d)"

  section "Install UltraContext"
  install_ultracontext

  section "Install Mutagen"
  install_mutagen

  section "Finish"
  print_summary
  run_setup
}

main "$@"
