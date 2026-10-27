#!/bin/sh
# uc installer: ultracontext, your AI agents' sessions on every machine.
#   curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/beyond/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ultracontext/ultracontext/beyond/install.sh | sh -s -- --hub
# Installs the prebuilt uc for this OS/CPU from GitHub Releases, verified against the release's
# SHA256SUMS; builds from source with cargo only when no prebuilt binary fits. Never uses sudo.
set -eu

REPO=${UC_REPO:-ultracontext/ultracontext}
VERSION=${UC_VERSION:-latest}
INSTALL_DIR=${UC_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}
BRANCH=${UC_BRANCH:-beyond}
FROM_SOURCE=${UC_FROM_SOURCE:-auto} # 1 = always build with cargo, 0 = never, else only when needed
DRY_RUN=${UC_DRY_RUN:-0}
HUB=0 WORK="" STAGED=""

say() { printf '%s\n' "$@" >&2; } # one line per argument
die() { printf 'uc-install: error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
usage: install.sh [--hub] [--version TAG] [--dir DIR] [--from-source] [--dry-run]
  --hub          afterwards, show how to run this machine as the always-on hub
  --version TAG  release to install, e.g. v1.0.0          (UC_VERSION, default: latest)
  --dir DIR      install directory                         (UC_INSTALL_DIR, default: ~/.local/bin)
  --from-source  build with cargo instead of downloading   (UC_FROM_SOURCE=1; 0 = never build)
  --dry-run      print the target and download URL, exit   (UC_DRY_RUN=1)
Also: UC_REPO=owner/repo (GitHub repo), UC_BRANCH=name (source branch, default: beyond)
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --hub) HUB=1 ;;
      --from-source) FROM_SOURCE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --version=*) VERSION=${1#*=} ;;
      --dir=*) INSTALL_DIR=${1#*=} ;;
      --version | --dir)
        [ $# -ge 2 ] || die "$1 needs a value"
        if [ "$1" = --dir ]; then INSTALL_DIR=$2; else VERSION=$2; fi; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  case $VERSION in [0-9]*) VERSION=v$VERSION ;; esac
  INSTALL_DIR=${INSTALL_DIR%/}
}

# TARGET = Rust target triple of the release asset for this machine, "" when none can exist.
detect_target() {
  os=$(uname -s) arch=$(uname -m) TARGET=""
  PLATFORM="$os/$arch"
  case $arch in
    x86_64 | amd64) arch=x86_64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) return 0 ;;
  esac
  case $os in
    Darwin) # an x86_64 shell under Rosetta on Apple silicon still gets the native build
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=aarch64; fi
      TARGET=$arch-apple-darwin ;;
    Linux) # releases are glibc builds; musl systems (Alpine) build from source
      for f in /lib/ld-musl-*; do if [ -e "$f" ]; then PLATFORM="$PLATFORM (musl)"; return 0; fi; done
      TARGET=$arch-unknown-linux-gnu ;;
  esac
}

# fetch URL FILE -> 0 downloaded, 2 not found (HTTP 404), 1 any other failure
fetch() {
  f_rc=0
  if has curl; then
    f_code=$(curl -sSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 \
      -w '%{http_code}' -o "$2" "$1") || f_rc=1
    case $f_rc:$f_code in 0:2??) return 0 ;; 0:404) return 2 ;; *) return 1 ;; esac
  fi
  has wget || die "curl or wget is required"
  wget -q -O "$2" "$1" || f_rc=$?
  case $f_rc in 0) return 0 ;; 8) return 2 ;; *) return 1 ;; esac
}

sha256() {
  if has sha256sum; then sha256sum "$1"
  elif has shasum; then shasum -a 256 "$1"
  else openssl dgst -sha256 -r "$1"
  fi | cut -d' ' -f1
}

# Same-directory rename: atomic, and safe while an older uc is still running from the old file.
install_bin() {
  if ! { mkdir -p "$INSTALL_DIR" 2>/dev/null && [ -w "$INSTALL_DIR" ]; }; then
    die "cannot write to $INSTALL_DIR; choose another directory with UC_INSTALL_DIR (no sudo is used)"
  fi
  INSTALL_DIR=$(CDPATH='' cd -- "$INSTALL_DIR" && pwd)
  STAGED="$INSTALL_DIR/.uc.$$.tmp"
  { cp "$1" "$STAGED" && chmod 755 "$STAGED"; } || die "could not write $STAGED"
  if [ "$(uname -s)" = Darwin ]; then xattr -d com.apple.quarantine "$STAGED" 2>/dev/null || true; fi
  mv -f "$STAGED" "$INSTALL_DIR/uc"
  STAGED=""
}

from_source() {
  why=$1
  [ "$FROM_SOURCE" != 0 ] || die "$why (UC_FROM_SOURCE=0: not building from source)"
  has cargo || die "$why, and cargo is not installed to build uc from source.
  Install Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  then run this installer again."
  if [ "$VERSION" = latest ]; then set -- --branch "$BRANCH"; else set -- --tag "$VERSION"; fi
  say "$why: building uc from source ($REPO $*), this takes a few minutes..."
  cargo install --locked --root "$WORK/cargo" --git "https://github.com/$REPO" "$@" ultracontext --bin uc ||
    die "cargo install failed (see above)"
  install_bin "$WORK/cargo/bin/uc"
}

install_release() {
  fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS" ||
    die "could not download $BASE/SHA256SUMS; refusing to install an unverified binary"
  want=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$WORK/SHA256SUMS")
  [ -n "$want" ] || die "SHA256SUMS has no entry for $ASSET"
  got=$(sha256 "$WORK/$ASSET")
  [ "$got" = "$want" ] || die "checksum mismatch for $ASSET (expected $want, got ${got:-nothing: no sha256 tool}); nothing installed"
  mkdir "$WORK/x"
  tar -xzf "$WORK/$ASSET" -C "$WORK/x" || die "could not unpack $ASSET"
  bin=$(find "$WORK/x" -type f -name uc | head -n 1)
  [ -n "$bin" ] || die "$ASSET does not contain a uc binary"
  chmod 755 "$bin"
  if err=$("$bin" --version 2>&1); then install_bin "$bin"; return 0; fi
  say "$err"
  from_source "the prebuilt $TARGET binary does not run on this machine (error above)"
}

path_hint() {
  case ${SHELL:-} in
    */fish) say "$INSTALL_DIR is not on your PATH. Add it:  fish_add_path $INSTALL_DIR"; return 0 ;;
    */zsh) rcfile="$HOME/.zshrc" ;;
    */bash) rcfile="$HOME/.bashrc"; if [ "$(uname -s)" = Darwin ]; then rcfile="$HOME/.bash_profile"; fi ;;
    *) rcfile="$HOME/.profile" ;;
  esac
  say "$INSTALL_DIR is not on your PATH. Add it, then open a new shell:"
  printf "  echo 'export PATH=\"%s:\$PATH\"' >> %s\n" "$INSTALL_DIR" "$rcfile" >&2
}

hub_hint() {
  me=$(id -un 2>/dev/null || echo you)
  say "" "Hub setup (this machine becomes the always-on source of truth):" \
    "  uc service install --hub     # run the hub now and at every boot"
  if [ "$(uname -s)" = Linux ]; then
    say "  loginctl enable-linger $me   # keep it running after you log out (may need sudo; not run for you)"
  fi
  say "Then on each laptop/workstation (after installing uc there):" \
    "  uc init $me@$(uname -n) --remote-uc $INSTALL_DIR/uc" \
    "  (use any ssh name that reaches this machine; --remote-uc matters because $INSTALL_DIR" \
    "   is usually not on the PATH of non-interactive ssh sessions)"
}

finish() {
  say "Installed $("$INSTALL_DIR/uc" --version 2>/dev/null || echo uc) at $INSTALL_DIR/uc"
  case ":$PATH:" in *":$INSTALL_DIR:"*) ;; *) path_hint ;; esac
  first=$(command -v uc 2>/dev/null || true)
  if [ -n "$first" ] && [ "$first" != "$INSTALL_DIR/uc" ]; then
    say "warning: uc on your PATH is $first, not this install; remove it so every tool runs the same uc"
  fi
  if has pgrep && pgrep -x uc >/dev/null 2>&1; then say "uc is running here: restart it to use the new version"; fi
  if [ "$HUB" = 1 ]; then hub_hint; else say "Next: uc init <hub>   (an ssh host like me@server, or 'local')"; fi
}

cleanup() { [ -z "$STAGED" ] || rm -f "$STAGED"; [ -z "$WORK" ] || rm -rf "$WORK"; }

main() {
  parse_args "$@"
  detect_target
  ASSET=uc-$TARGET.tar.gz BASE=https://github.com/$REPO/releases/download/$VERSION
  if [ "$VERSION" = latest ]; then BASE=https://github.com/$REPO/releases/latest/download; fi
  if [ "$DRY_RUN" = 1 ]; then
    if [ -z "$TARGET" ]; then echo "target:  none for $PLATFORM (would build from source)"; exit 0; fi
    printf 'target:  %s\nurl:     %s\nsums:    %s\ninstall: %s\n' \
      "$TARGET" "$BASE/$ASSET" "$BASE/SHA256SUMS" "$INSTALL_DIR/uc"
    exit 0
  fi
  WORK=$(mktemp -d 2>/dev/null || mktemp -d -t uc-install) || die "cannot create a temporary directory"
  trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' HUP TERM
  if [ "$FROM_SOURCE" = 1 ]; then from_source "UC_FROM_SOURCE=1"; finish; return 0; fi
  if [ -z "$TARGET" ]; then from_source "no prebuilt uc for $PLATFORM"; finish; return 0; fi
  say "Downloading uc ($VERSION) for $TARGET..."
  rc=0; fetch "$BASE/$ASSET" "$WORK/$ASSET" || rc=$?
  case $rc in
    0) install_release ;;
    2) from_source "no prebuilt uc ($VERSION) for $TARGET" ;;
    *) die "could not download $BASE/$ASSET (network problem?)" ;;
  esac
  finish
}

main "$@" # last line on purpose: a truncated download defines functions but runs nothing
