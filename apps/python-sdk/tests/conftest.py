"""Shared pytest fixtures — the `uc` shim that drives the built JS CLI.

The shim points UC_BIN at apps/cli/dist/uc.mjs via node, so the local-backend
tests exercise the REAL local engine without needing bun/tsx. Each test runs in a
temp cwd with its own UC_DB_URL, keeping the local sqlite store isolated.
"""

import shutil
import stat
from pathlib import Path

import pytest


# -- repo paths ---------------------------------------------------------------

# the repo root (apps/python-sdk/tests -> up 3) and the built JS CLI entrypoint
REPO_ROOT = Path(__file__).resolve().parents[3]
UC_DIST = REPO_ROOT / "apps" / "cli" / "dist" / "uc.mjs"


# -- shim fixture -------------------------------------------------------------


@pytest.fixture
def uc_shim(tmp_path, monkeypatch):
    """A `uc` shim that execs node on the built CLI, forwarding all args."""

    # skip when the toolchain to run the JS CLI is absent
    node = shutil.which("node")
    if node is None or not UC_DIST.exists():
        pytest.skip("node or apps/cli/dist/uc.mjs missing — build the CLI first")

    # write an executable shell shim: shebang then exec node <uc.mjs> "$@"
    shim = tmp_path / "uc"
    shim.write_text(f'#!/bin/sh\nexec "{node}" "{UC_DIST}" "$@"\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    # point the SDK's binary locator at the shim
    monkeypatch.setenv("UC_BIN", str(shim))
    return str(shim)
