#!/usr/bin/env bash
# =============================================================================
# build-wheels — produce the 5 platform-specific `ultracontext` wheels (each
# embedding the matching standalone `uc` binary) plus a pure-Python sdist.
#
# Each platform wheel ships ultracontext/_bin/uc[.exe] — the bun-compiled,
# standalone CLI (bun:sqlite embedded). Because the binary needs no CPython and
# no Node, the wheels are tagged py3-none-<platform> (interpreter-agnostic),
# stamped by hatch_build.py via UC_WHEEL_PLATFORM. The sdist carries no binary,
# so a pip-install from it falls back to UC_BIN / a `uc` on PATH.
#
# Usage:
#   apps/python-sdk/scripts/build-wheels.sh            # all 5 wheels + sdist
#   apps/python-sdk/scripts/build-wheels.sh darwin-arm64   # one wheel only
#
# Environment:
#   PYTHON   - python interpreter that runs `-m build` (default: python3)
#   OUT_DIR  - wheel output directory (default: apps/python-sdk/dist)
# =============================================================================

set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────

# this script lives in apps/python-sdk/scripts — the SDK root is one level up
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sdk_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${sdk_dir}/../.." && pwd)"

# where the CLI build drops the cross-compiled binaries, and where wheels land
bin_src="${repo_root}/apps/cli/dist/bin"
bin_dst="${sdk_dir}/ultracontext/_bin"
out_dir="${OUT_DIR:-${sdk_dir}/dist}"

python="${PYTHON:-python3}"

# ─── Target matrix ─────────────────────────────────────────────────────────--

# <target> : <binary file (uc-<os>-<arch>[.exe])> : <wheel platform tag>
targets=(
  "darwin-arm64:uc-darwin-arm64:macosx_11_0_arm64"
  "darwin-x64:uc-darwin-x64:macosx_10_9_x86_64"
  "linux-arm64:uc-linux-arm64:manylinux2014_aarch64"
  "linux-x64:uc-linux-x64:manylinux2014_x86_64"
  "windows-x64:uc-windows-x64.exe:win_amd64"
)

# `build-wheels.sh darwin-arm64` builds only the matching wheel
filter="${1:-}"

# ─── Clean helper ────────────────────────────────────────────────────────────

# wipe the bundled-binary dir so each target builds from a known-empty state
clean_bin() {
  rm -rf "$bin_dst"
}
trap clean_bin EXIT

# ─── Cross-compile the uc binaries ───────────────────────────────────────────

# build only what we need: a single filtered target, else all 5
echo "→ Building uc binaries (pnpm --filter ultracontext run build:binaries)"
if [[ -n "$filter" ]]; then
  pnpm --dir "$repo_root" --filter ultracontext run build:binaries "$filter"
else
  pnpm --dir "$repo_root" --filter ultracontext run build:binaries
fi
echo ""

# ─── Build loop ────────────────────────────────────────────────────────────--

mkdir -p "$out_dir"
built=0

for entry in "${targets[@]}"; do
  IFS=':' read -r target asset plat <<<"$entry"

  # skip targets the optional filter doesn't name
  if [[ -n "$filter" && "$target" != "$filter" ]]; then
    continue
  fi

  src="${bin_src}/${asset}"
  if [[ ! -f "$src" ]]; then
    echo "error: missing binary ${src} — did build:binaries produce it?" >&2
    exit 1
  fi

  # stage the binary as ultracontext/_bin/uc (or uc.exe on windows)
  clean_bin
  mkdir -p "$bin_dst"
  name="uc"; [[ "$asset" == *.exe ]] && name="uc.exe"
  cp "$src" "${bin_dst}/${name}"
  chmod +x "${bin_dst}/${name}"

  # build the platform-tagged wheel (hatch_build.py stamps py3-none-<plat>)
  echo "→ wheel ${target}  ⇒  py3-none-${plat}"
  UC_WHEEL_PLATFORM="$plat" "$python" -m build --wheel --outdir "$out_dir" "$sdk_dir"

  built=$((built + 1))
done

# clear the bundle before producing the binary-free sdist
clean_bin

# ─── Pure-Python sdist (PATH / UC_BIN fallback) ──────────────────────────────

# only when building the full set — a single-target run just wants its wheel
if [[ -z "$filter" ]]; then
  echo "→ sdist (pure-Python, no bundled binary)"
  "$python" -m build --sdist --outdir "$out_dir" "$sdk_dir"
fi

# ─── Report ──────────────────────────────────────────────────────────────────

# a filter that matched nothing is a usage error, not a silent no-op
if [[ "$built" -eq 0 ]]; then
  echo "error: no target matched filter '${filter}'" >&2
  echo "  known targets: darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-x64" >&2
  exit 1
fi

echo ""
echo "Done — artifacts in ${out_dir}:"
ls -1 "$out_dir"/*.whl "$out_dir"/*.tar.gz 2>/dev/null || true
