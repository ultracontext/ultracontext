"""Local-backend tests — drive the SDK against a shimmed `uc` binary.

The shim points UC_BIN at the built JS CLI (apps/cli/dist/uc.mjs) via node, so
these tests exercise the REAL local engine without needing bun/tsx. Each test
runs in a temp cwd with its own UC_DB_URL, so the local sqlite store is isolated.
"""

import asyncio

import pytest

from ultracontext import AsyncUltraContext, UltraContext
from ultracontext._local import _LocalBackend


# the `uc_shim` fixture lives in conftest.py (shared across local test modules)


# -- mode resolution (unit, no spawn) -----------------------------------------


def test_mode_resolves_local_with_no_config():
    """No api key and no explicit mode -> local."""
    client = UltraContext()
    assert client._mode == "local"


def test_mode_resolves_remote_with_api_key():
    """An api key (and no explicit mode) -> remote."""
    client = UltraContext(api_key="sk_test")
    assert client._mode == "remote"


def test_explicit_local_mode_wins_over_api_key():
    """An explicit mode='local' forces local even WITH a key."""
    client = UltraContext(api_key="sk_test", mode="local")
    assert client._mode == "local"


def test_async_mode_resolution():
    """Async client resolves the mode identically."""
    assert AsyncUltraContext()._mode == "local"
    assert AsyncUltraContext(api_key="sk_test")._mode == "remote"
    assert AsyncUltraContext(api_key="sk_test", mode="local")._mode == "local"


# -- backend binary location --------------------------------------------------


def test_backend_uses_uc_bin_env(uc_shim, tmp_path):
    """UC_BIN is honored as the binary path."""
    backend = _LocalBackend(db=str(tmp_path / "x.db"))
    assert backend._bin == uc_shim


# -- sync integration ---------------------------------------------------------


def test_sync_local_lifecycle(uc_shim, tmp_path, monkeypatch):
    """create -> append(single + list) -> get -> list -> update -> delete*."""
    monkeypatch.chdir(tmp_path)
    db = str(tmp_path / "uc.db")
    uc = UltraContext(mode="local", db=db)

    # create a root context
    created = uc.create()
    cid = created["id"]
    assert isinstance(cid, str) and cid.startswith("ctx_")
    assert "created_at" in created

    # append a single message
    a1 = uc.append(cid, {"role": "user", "content": "hi"})
    assert len(a1["data"]) == 1
    assert isinstance(a1["version"], int)

    # append a LIST of 2 (bug-fixed: two distinct messages, one shared version)
    a2 = uc.append(cid, [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}])
    assert len(a2["data"]) == 2
    assert isinstance(a2["version"], int)

    # get -> 3 messages total
    got = uc.get(cid)
    assert len(got["data"]) == 3
    assert isinstance(got["version"], int)

    # list -> the project's contexts include ours
    listed = uc.get()
    assert any(c["id"] == cid for c in listed["data"])

    # update by index -> new version
    upd = uc.update(cid, index=0, content="edited")
    assert isinstance(upd["version"], int)
    assert upd["data"][0]["content"] == "edited"

    # soft delete a message (local returns the {deleted, id, data, version} superset)
    soft = uc.delete(cid, 0)
    assert soft["deleted"] is True
    assert soft["id"] == cid

    # permanent delete the whole context
    perm = uc.delete(cid, permanent=True)
    assert perm["deleted"] is True
    assert perm["id"] == cid


def test_sync_delete_many(uc_shim, tmp_path, monkeypatch):
    """delete_many fans out permanent deletes and assembles a results body."""
    monkeypatch.chdir(tmp_path)
    db = str(tmp_path / "uc.db")
    uc = UltraContext(mode="local", db=db)

    # create two contexts to delete
    ids = [uc.create()["id"], uc.create()["id"]]

    # delete_many -> per-id results + count
    res = uc.delete_many(ids)
    assert res["deleted_count"] == 2
    assert {r["id"] for r in res["results"]} == set(ids)
    assert all(r["deleted"] for r in res["results"])


def test_sync_create_with_metadata(uc_shim, tmp_path, monkeypatch):
    """create(metadata=...) flows --meta key=val and echoes back."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    created = uc.create(metadata={"foo": "bar"})
    assert created["metadata"]["foo"] == "bar"


def test_sync_batch_update_not_implemented(uc_shim, tmp_path, monkeypatch):
    """Batch update (a list of updates) is local-unsupported -> NotImplementedError."""
    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))
    cid = uc.create()["id"]
    uc.append(cid, {"role": "user", "content": "x"})

    with pytest.raises(NotImplementedError):
        uc.update(cid, [{"index": 0, "content": "y"}])


def test_sync_error_raises(uc_shim, tmp_path, monkeypatch):
    """A nonzero uc exit surfaces as UltraContextError (parity with remote throw)."""
    from ultracontext import UltraContextError

    monkeypatch.chdir(tmp_path)
    uc = UltraContext(mode="local", db=str(tmp_path / "uc.db"))

    # get a nonexistent context -> the CLI exits nonzero
    with pytest.raises(UltraContextError):
        uc.get("ctx_does_not_exist_000000000000")


# -- async integration --------------------------------------------------------


def test_async_local_lifecycle(uc_shim, tmp_path, monkeypatch):
    """Async path mirrors the sync lifecycle end-to-end."""
    monkeypatch.chdir(tmp_path)
    db = str(tmp_path / "uc-async.db")

    async def run():
        uc = AsyncUltraContext(mode="local", db=db)

        # create + append single + append list
        cid = (await uc.create())["id"]
        await uc.append(cid, {"role": "user", "content": "hi"})
        a2 = await uc.append(cid, [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}])
        assert len(a2["data"]) == 2

        # get -> 3 messages
        got = await uc.get(cid)
        assert len(got["data"]) == 3

        # list, update, delete soft + permanent
        listed = await uc.get()
        assert any(c["id"] == cid for c in listed["data"])
        upd = await uc.update(cid, index=0, content="edited")
        assert upd["data"][0]["content"] == "edited"
        soft = await uc.delete(cid, 0)
        assert soft["deleted"] is True
        perm = await uc.delete(cid, permanent=True)
        assert perm["deleted"] is True

    asyncio.run(run())
