#!/usr/bin/env bash
# =============================================================================
# build-binaries — cross-compile the `uc` CLI into standalone Bun executables,
# one per release target. Each artifact embeds the JS bundle + the bun:sqlite
# native driver (the runtime picks bun:sqlite under Bun; see
# packages/storage/src/sqlite/index.ts). These files are what the GitHub release
# serves and install.sh / install.ps1 download.
#
# Usage:
#   apps/cli/scripts/build-binaries.sh            # build all 5 targets
#   apps/cli/scripts/build-binaries.sh darwin-arm64   # build one asset
#
# Environment:
#   BUN          - path to the bun binary (default: bun on PATH, else ~/.bun/bin/bun)
#   OUT_DIR      - output directory (default: apps/cli/dist/bin)
# =============================================================================

set -euo pipefail

# ─── Paths ───────────────────────────────────────────────────────────────────

# this script lives in apps/cli/scripts — the CLI package root is one level up
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cli_dir="$(cd "${script_dir}/.." && pwd)"

entry="${cli_dir}/src/cli/bin.ts"
out_dir="${OUT_DIR:-${cli_dir}/dist/bin}"

# ─── Toolchain ─────────────────────────────────────────────────────────────--

# prefer an explicit $BUN, then bun on PATH, then the default install location
if [[ -n "${BUN:-}" ]]; then
  bun="$BUN"
elif command -v bun >/dev/null 2>&1; then
  bun="$(command -v bun)"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  bun="$HOME/.bun/bin/bun"
else
  echo "error: bun not found (set \$BUN or install from https://bun.sh)" >&2
  exit 1
fi

# ─── Version ───────────────────────────────────────────────────────────────--

# the package version is baked into the binary via --define so `uc version`
# reports the right number (the compiled binary can't readFileSync package.json)
version="$("$bun" --print "require('${cli_dir}/package.json').version")"

# ─── Target matrix ─────────────────────────────────────────────────────────--

# bun cross-compile target  →  release asset name (uc-<os>-<arch>[.exe])
targets=(
  "bun-darwin-arm64:uc-darwin-arm64"
  "bun-darwin-x64:uc-darwin-x64"
  "bun-linux-x64:uc-linux-x64"
  "bun-linux-arm64:uc-linux-arm64"
  "bun-windows-x64:uc-windows-x64.exe"
)

# ─── Optional single-target filter ───────────────────────────────────────────

# `build-binaries.sh darwin-arm64` builds only the matching asset
filter="${1:-}"

# ─── Build loop ────────────────────────────────────────────────────────────--

mkdir -p "$out_dir"

echo "Building uc v${version} → ${out_dir}"
echo "Using bun: ${bun} ($("$bun" --version))"
echo ""

built=0

for entry_pair in "${targets[@]}"; do
  bun_target="${entry_pair%%:*}"
  asset="${entry_pair##*:}"

  # skip targets that don't match the optional filter (matched against the asset)
  if [[ -n "$filter" && "$asset" != *"$filter"* ]]; then
    continue
  fi

  outfile="${out_dir}/${asset}"

  echo "→ ${bun_target}  ⇒  ${asset}"

  # compile: bundle the CLI, embed bun:sqlite, inline the version define
  "$bun" build "$entry" \
    --compile \
    --target="$bun_target" \
    --define "UC_COMPILED_VERSION=\"${version}\"" \
    --outfile "$outfile"

  built=$((built + 1))
done

echo ""

# a non-zero filter that matched nothing is a usage error, not a silent no-op
if [[ "$built" -eq 0 ]]; then
  echo "error: no targets matched filter '${filter}'" >&2
  echo "  known assets: uc-darwin-arm64 uc-darwin-x64 uc-linux-x64 uc-linux-arm64 uc-windows-x64.exe" >&2
  exit 1
fi

echo "Done — ${built} binary(ies) in ${out_dir}"
ls -lh "$out_dir"
