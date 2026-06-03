"""Local-backend polish tests — db-scheme detection, metadata fidelity,
soft-delete shape, and error-envelope unwrapping.

These exercise the targeted fixes (B2/B3/B4/C3). The integration tests reuse the
`uc_shim` fixture from test_local.py via conftest, so the REAL local engine runs.
"""

import pytest

from ultracontext import AsyncUltraContext, UltraContext, UltraContextError
from ultracontext._local import _LocalBackend


# -- B2: db-scheme detection (unit, no spawn) ---------------------------------


def test_bare_path_is_file_prefixed():
    """A bare relative path gets a `file:` scheme."""
    backend = _LocalBackend(db="ultracontext.db")
    assert backend._env()["UC_DB_URL"] == "file:ultracontext.db"


def test_scheme_url_rides_through():
    """An explicit scheme (libsql:/file:/http:) is passed through untouched."""
    for url in ("libsql://host", "file:/abs/path.db", "http://x"):
        assert _LocalBackend(db=url)._env()["UC_DB_URL"] == url


def test_path_with_midstring_colon_is_file_prefixed():
    """A relative path with a colon mid-string is NOT misread as a scheme."""
    backend = _LocalBackend(db="dir/my:db.sqlite")
    assert backend._env()["UC_DB_URL"] == "file:dir/my:db.sqlite"


def test_drive_letter_is_a_path():
    """A single-letter prefix (Windows drive C:) is a path, not a scheme."""
    backend = _LocalBackend(db="C:\\data\\uc.db")
    assert backend._env()["UC_DB_URL"] == "file:C:\\data\\uc.db"


# -- delete safety (unit, no spawn — validation happens before any backend) ----


def test_delete_empty_ids_raises():
    """An empty ids list must raise, never drift toward a permanent wipe."""
    uc = UltraContext()  # local mode; validation fires before any subprocess
    with pytest.raises(ValueError, match="non-empty"):
        uc.delete("ctx_x", [])


def test_async_delete_empty_ids_raises():
    """The async client enforces the same empty-ids guard."""
    import asyncio

    with pytest.raises(ValueError, match="non-empty"):
        asyncio.run(AsyncUltraContext().delete("ctx_x", []))


# -- B3: metadata fidelity (unit, no spawn) -----------------------------------


def test_string_metadata_passes_raw():
    """A string metadata value flows verbatim as key=val."""
    from ultracontext._local import _meta_args

    assert _meta_args({"k": "v"}) == ["--meta", "k=v"]


def test_nonstring_metadata_json_encoded():
    """A non-string metadata value is JSON-encoded into the string (local limit)."""
    from ultracontext._local import _meta_args

    assert _meta_args({"n": 7}) == ["--meta", "n=7"]
    assert _meta_args({"ok": True}) == ["--meta", "ok=true"]


def test_string_metadata_roundtrips_as_string(uc_shim, tmp_path, monkeypatch):
    """A string metadata value round-trips locally as exactly that string."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    created = uc.create(metadata={"k": "v"})
    assert created["metadata"]["k"] == "v"


# -- B4: soft-delete shape (integration) --------------------------------------


def test_soft_delete_returns_data_and_version(uc_shim, tmp_path, monkeypatch):
    """Local soft delete returns the {deleted, id, data, version} superset."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    cid = uc.create()["id"]
    uc.append(cid, {"role": "user", "content": "hi"})
    soft = uc.delete(cid, 0)

    # deleted/id AND the data+version present for remote parity
    assert soft["deleted"] is True
    assert soft["id"] == cid
    assert "data" in soft
    assert isinstance(soft["version"], int)


# -- C3: error-envelope unwrapping (integration) ------------------------------


def test_error_surfaces_message_not_json_blob(uc_shim, tmp_path, monkeypatch):
    """A {"error": "..."} CLI envelope surfaces the .error string, not the blob."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    with pytest.raises(UltraContextError) as exc:
        uc.get("ctx_does_not_exist_000000000000")

    # the bare message, no surrounding JSON braces or "uc exited" noise
    msg = str(exc.value)
    assert "Context not found" in msg
    assert "{" not in msg


def test_delete_many_error_row_is_clean_message(uc_shim, tmp_path, monkeypatch):
    """A failing delete_many row carries the .error string, not a JSON blob."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    res = uc.delete_many(["ctx_does_not_exist_000000000000"])
    assert res["deleted_count"] == 0
    row = res["results"][0]
    assert row["deleted"] is False
    assert "{" not in row["error"]


def test_error_falls_back_to_raw_when_not_json(uc_shim, tmp_path, monkeypatch):
    """Non-JSON stderr falls back to the raw text in the error."""
    monkeypatch.chdir(tmp_path)
    backend = _LocalBackend(db=str(tmp_path / "uc.db"))

    with pytest.raises(UltraContextError) as exc:
        backend._parse(1, "", "boom not json")
    assert "boom not json" in str(exc.value)
