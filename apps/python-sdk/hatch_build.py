"""Hatch build hook — embed the platform `uc` binary into platform wheels.

The local backend (ultracontext/_local.py) resolves the `uc` binary in order:

    1. env UC_BIN                         (override — used by tests + power users)
    2. bundled ultracontext/_bin/uc[.exe] (THIS hook's job: embed per-platform)
    3. shutil.which('uc')                 (a `uc` already on PATH)

To ship a self-contained wheel per platform, `scripts/build-wheels.sh` cross-
compiles the `uc` CLI into one standalone Bun binary, drops it at
`ultracontext/_bin/uc` (or `uc.exe` on Windows), sets UC_WHEEL_PLATFORM, and
builds the wheel. This hook force-includes that dir and STAMPS the wheel tag.

WHY py3-none-<plat> (not cp3x): the `uc` binary is bun-compiled and standalone
(bun:sqlite embedded) — it runs with no Node and no specific CPython. So the
wheel is interpreter-AGNOSTIC but platform-SPECIFIC. We set the tag explicitly
(`build_data['tag']`) rather than letting hatchling infer a cp3x-abi3 tag.

No binary present -> a pure-Python wheel/sdist (local backend falls back to
PATH/UC_BIN), built from the same source tree.
"""

import os
import sys
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


# -- host platform default ----------------------------------------------------

# the wheel platform tag to use when UC_WHEEL_PLATFORM is unset (host build).
# derived from the running interpreter's own tags so a plain `hatch build` on
# this machine still produces a correctly-tagged fat wheel.
def _host_platform_tag() -> str:
    from packaging.tags import sys_tags

    # the first concrete tag's platform segment (e.g. macosx_11_0_arm64)
    return next(iter(sys_tags())).platform


# -- build hook ---------------------------------------------------------------


class CustomBuildHook(BuildHookInterface):
    """Stamp a py3-none-<plat> tag iff a bundled `uc` binary is present."""

    def initialize(self, version, build_data):
        # the binary build-wheels.sh is expected to have placed in the package
        name = "uc.exe" if sys.platform == "win32" else "uc"
        rel = f"ultracontext/_bin/{name}"
        binary = Path(self.root) / rel

        # no binary -> a pure-Python wheel (local backend falls back to PATH/UC_BIN)
        if not binary.exists():
            return

        # binary present -> force-include it so the wheel ships the executable
        build_data["force_include"][str(binary)] = rel

        # platform-specific, but interpreter-AGNOSTIC: stamp py3-none-<plat>
        # explicitly (the binary is standalone — no CPython/Node dependency).
        plat = os.environ.get("UC_WHEEL_PLATFORM") or _host_platform_tag()
        build_data["pure_python"] = False
        build_data["tag"] = f"py3-none-{plat}"
