from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from importlib import metadata
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    temp_dir: Path | None = None

    try:
        cli, temp_dir = _resolve_cli()
        result = subprocess.run([str(cli), *args], env=_bootstrap_env(), check=False)
        return result.returncode
    except Exception as error:
        print(f"internal: {error}", file=sys.stderr)
        return 1
    finally:
        if temp_dir is not None:
            shutil.rmtree(temp_dir, ignore_errors=True)


def _resolve_cli() -> tuple[Path, Path | None]:
    candidates = [
        os.environ.get("ULTRACONTEXT_CLI"),
        str(_package_dir() / f"uc-{_release_target()}"),
        str(_package_dir() / _executable_name("uc")),
        shutil.which("uc"),
    ]

    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.exists():
            return path, None

    return _download_release_cli()


def _bootstrap_env() -> dict[str, str]:
    env = dict(os.environ)
    env.setdefault("UC_PYTHON_PACKAGE_NAME", "ultracontext")

    if "UC_PYTHON_SPEC" not in env:
        try:
            env["UC_PYTHON_SPEC"] = f"ultracontext=={metadata.version('ultracontext')}"
        except metadata.PackageNotFoundError:
            env["UC_PYTHON_SPEC"] = "ultracontext"

    return env


def _download_release_cli() -> tuple[Path, Path]:
    target = _release_target()
    repo = os.environ.get("UC_REPO", "https://github.com/ultracontext/ultracontext")
    version = os.environ.get("UC_VERSION", "latest")
    base = (
        f"{repo}/releases/latest/download"
        if version == "latest"
        else f"{repo}/releases/download/{version}"
    )
    url = f"{base}/uc-{target}.tar.gz"

    temp_dir = Path(tempfile.mkdtemp(prefix="ultracontext-python-"))
    archive = temp_dir / "uc.tar.gz"

    with urllib.request.urlopen(url) as response:
        archive.write_bytes(response.read())

    with tarfile.open(archive, "r:gz") as tar:
        _safe_extract(tar, temp_dir)

    cli = _find_extracted_cli(temp_dir)
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli, temp_dir


def _find_extracted_cli(root: Path) -> Path:
    name = _executable_name("uc")
    for path in root.rglob(name):
        if path.is_file():
            return path
    raise RuntimeError("release archive did not contain uc")


def _safe_extract(tar: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in tar.getmembers():
        target = (destination / member.name).resolve()
        if target != root and root not in target.parents:
            raise RuntimeError(f"release archive contains unsafe path: {member.name}")
    tar.extractall(destination)


def _release_target() -> str:
    system = platform.system()
    machine = platform.machine().lower()

    if machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    elif machine in {"x86_64", "amd64"}:
        arch = "x86_64"
    else:
        raise RuntimeError(f"unsupported architecture for ultracontext CLI: {machine}")

    if system == "Darwin":
        return f"{arch}-apple-darwin"
    if system == "Linux":
        return f"{arch}-unknown-linux-gnu"

    raise RuntimeError(f"unsupported platform for ultracontext CLI: {system}")


def _executable_name(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def _package_dir() -> Path:
    return Path(__file__).resolve().parent


if __name__ == "__main__":
    raise SystemExit(main())
