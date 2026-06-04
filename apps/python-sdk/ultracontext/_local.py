"""Local backend — drives the bundled `uc` CLI as a subprocess.

Local-by-default parity with the JS SDK: instead of HTTP, each method shells out
to the `uc` binary with `--json`, parses stdout, and raises UltraContextError on
a nonzero exit (carrying stderr). The binary opens the SAME local sqlite engine
(@ultracontext/core) the CLI uses, so the SDK reuses the engine — no duplication.

Binary location order: env UC_BIN -> bundled ultracontext/_bin/uc[.exe] ->
shutil.which('uc'). The db defaults to ./ultracontext.db in the cwd (app-specific,
NOT ~/.ultracontext/uc.db); it is passed via the UC_DB_URL env overlay.
"""

import asyncio
import importlib.resources as resources
import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Union, cast

from .exceptions import UltraContextError
from .types import (
    AppendResponse,
    CreateContextResponse,
    DeleteManyResponse,
    DeleteManyResult,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    PermanentDeleteResponse,
    UpdateResponse,
)


# -- db url -------------------------------------------------------------------

# a leading URI scheme (file:/libsql:/http: — two+ chars before the colon),
# mirroring the JS SDK's toDbUrl. A SINGLE-letter prefix (a Windows drive like
# C:) is a PATH, not a scheme. A colon after a slash (dir/my:db) never matches.
# A multi-char leading token (`data:base.db`) still reads as a scheme — prefix
# `./` to force a path.
_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]+:", re.IGNORECASE)


# -- binary location ----------------------------------------------------------

# resolve the `uc` binary: env override, then bundled platform binary, then PATH.
def _locate_bin() -> str:
    # explicit override wins (tests + power users)
    env_bin = os.environ.get("UC_BIN")
    if env_bin:
        return env_bin

    # bundled per-platform binary inside the wheel (ultracontext/_bin/uc[.exe])
    name = "uc.exe" if sys.platform == "win32" else "uc"
    try:
        bundled = resources.files("ultracontext").joinpath("_bin", name)
        if bundled.is_file():
            return str(bundled)
    except (ModuleNotFoundError, FileNotFoundError):
        pass

    # fall back to a `uc` already on PATH
    found = shutil.which("uc")
    if found:
        return found

    # nothing found — a clear, actionable error
    raise UltraContextError(
        "uc binary not found — set UC_BIN, install the `ultracontext` CLI, "
        "or use a remote api_key"
    )


# -- argv builders ------------------------------------------------------------

# render a metadata dict into repeatable `--meta key=val` argv items.
# LOCAL LIMITATION: the CLI stores `--meta` values as RAW STRINGS, so local
# metadata is string-valued. A string passes verbatim ({'k':'v'} -> 'v');
# a non-string is JSON-encoded INTO that string (7 -> '7', so it can't
# round-trip as a structured number — remote stores it structured).
def _meta_args(metadata: Optional[Dict[str, Any]]) -> List[str]:
    if not metadata:
        return []
    args: List[str] = []
    for key, value in metadata.items():
        # strings pass raw; non-strings are JSON-encoded into the string value
        rendered = value if isinstance(value, str) else json.dumps(value)
        args += ["--meta", f"{key}={rendered}"]
    return args


# -- error unwrapping ---------------------------------------------------------

# the CLI emits JSON errors as {"error": "..."} on stdout — surface that .error
# string instead of the raw blob. Fall back to the raw stderr/stdout text when
# it isn't JSON or carries no .error (parity with remote's thrown message).
def _error_message(stderr: str, stdout: str) -> str:
    raw = stderr.strip() or stdout.strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
            return cast(str, parsed["error"])
    except (ValueError, TypeError):
        pass
    return raw


# -- backend ------------------------------------------------------------------


class _LocalBackend:
    """Maps SDK methods onto `uc <verb> --json` subprocess calls."""

    def __init__(self, db: Optional[str] = None):
        # resolve the binary once; the db env overlay is built per-spawn
        self._bin = _locate_bin()
        self._db = db or "ultracontext.db"

    # -- spawn env ------------------------------------------------------------

    # the child env: inherit + force UC_DB_URL to the app-specific local db.
    # a bare path is `file:`-prefixed; an explicit scheme (file:/libsql:/...) rides through.
    def _env(self) -> Dict[str, str]:
        db_url = self._db if _SCHEME.match(self._db) else f"file:{self._db}"
        return {**os.environ, "UC_DB_URL": db_url}

    # -- sync run -------------------------------------------------------------

    # run `uc <args> --json`, parse stdout JSON, raise on nonzero exit (with stderr).
    # NEVER shell=True — argv is a list, so user values can't inject.
    def _run(self, args: List[str]) -> Any:
        proc = subprocess.run(
            [self._bin, *args, "--json"],
            capture_output=True,
            text=True,
            env=self._env(),
        )
        return self._parse(proc.returncode, proc.stdout, proc.stderr)

    # -- async run ------------------------------------------------------------

    # the asyncio twin of _run — same argv, same parse + error contract.
    async def _arun(self, args: List[str]) -> Any:
        proc = await asyncio.create_subprocess_exec(
            self._bin,
            *args,
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._env(),
        )
        out, err = await proc.communicate()
        return self._parse(proc.returncode, out.decode(), err.decode())

    # -- result parse ---------------------------------------------------------

    # shared exit + JSON handling — nonzero raises the unwrapped error, empty stdout -> None
    def _parse(self, code: Optional[int], stdout: str, stderr: str) -> Any:
        if code != 0:
            raise UltraContextError(_error_message(stderr, stdout))
        text = stdout.strip()
        if not text:
            return None
        return json.loads(text)

    # -- create ---------------------------------------------------------------

    # uc create [--from][--version][--at][--before][--meta ...] -> {id, metadata, created_at}
    def _create_args(
        self,
        from_: Optional[str],
        version: Optional[int],
        at: Optional[int],
        before: Optional[str],
        metadata: Optional[Dict[str, Any]],
    ) -> List[str]:
        args = ["context", "create"]
        if from_ is not None:
            args += ["--from", from_]
        if version is not None:
            args += ["--version", str(version)]
        if at is not None:
            args += ["--at", str(at)]
        if before is not None:
            args += ["--before", before]
        return args + _meta_args(metadata)

    def create(self, **kw: Any) -> CreateContextResponse:
        return cast(CreateContextResponse, self._run(self._create_args(**kw)))

    async def acreate(self, **kw: Any) -> CreateContextResponse:
        return cast(CreateContextResponse, await self._arun(self._create_args(**kw)))

    # -- append ---------------------------------------------------------------

    # uc append <id> --message <json> -> {data, version, id}. a dict OR list is
    # JSON-encoded; the CLI appends a list as multiple messages (one version bump).
    def _append_args(self, context_id: str, data: Union[Dict[str, Any], List[Dict[str, Any]]]) -> List[str]:
        return ["context", "append", context_id, "--message", json.dumps(data)]

    def append(self, context_id: str, data: Any) -> AppendResponse:
        return cast(AppendResponse, self._run(self._append_args(context_id, data)))

    async def aappend(self, context_id: str, data: Any) -> AppendResponse:
        return cast(AppendResponse, await self._arun(self._append_args(context_id, data)))

    # -- get / list -----------------------------------------------------------

    # single-context read: uc get <id> [--version][--at][--before][--history] -> {data, version, versions?}
    def _get_args(
        self,
        context_id: str,
        version: Optional[int],
        at: Optional[int],
        before: Optional[str],
        history: Optional[bool],
    ) -> List[str]:
        args = ["context", "get", context_id]
        if version is not None:
            args += ["--version", str(version)]
        if at is not None:
            args += ["--at", str(at)]
        if before is not None:
            args += ["--before", before]
        if history:
            args += ["--history"]
        return args

    # listing: uc list [--limit][--source][--project_path] -> {data: [{id, metadata, created_at}]}
    def _list_args(self, limit: Optional[int]) -> List[str]:
        args = ["context", "list"]
        if limit is not None:
            args += ["--limit", str(limit)]
        return args

    def get(self, context_id: str, **kw: Any) -> GetContextResponse:
        return cast(GetContextResponse, self._run(self._get_args(context_id, **kw)))

    async def aget(self, context_id: str, **kw: Any) -> GetContextResponse:
        return cast(GetContextResponse, await self._arun(self._get_args(context_id, **kw)))

    def list(self, limit: Optional[int] = None) -> ListContextsResponse:
        return cast(ListContextsResponse, self._run(self._list_args(limit)))

    async def alist(self, limit: Optional[int] = None) -> ListContextsResponse:
        return cast(ListContextsResponse, await self._arun(self._list_args(limit)))

    # -- update ---------------------------------------------------------------

    # uc update <id> (--id|--index) --content <c> [--meta] -> {data, version}.
    # SINGLE-target only: the local CLI has no batch-update verb, so a list of
    # updates or a non-content single field raises NotImplementedError.
    def _update_args(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]],
        id: Optional[str],
        index: Optional[int],
        metadata: Optional[Dict[str, Any]],
        fields: Dict[str, Any],
    ) -> List[str]:
        # batch mode is remote-only
        if updates is not None:
            raise NotImplementedError(
                "local update supports a single target only — pass id=/index= + content=, "
                "not a list of updates (use a remote api_key for batch updates)"
            )

        # only `content` is editable via the CLI today
        extra = {k: v for k, v in fields.items() if k != "content"}
        if extra:
            raise NotImplementedError(
                f"local update supports the `content` field only — unsupported: {sorted(extra)} "
                "(use a remote api_key for other fields)"
            )
        if "content" not in fields:
            raise NotImplementedError("local update requires content= (the only locally-editable field)")

        args = ["context", "update", context_id]
        if id is not None:
            args += ["--id", id]
        if index is not None:
            args += ["--index", str(index)]
        args += ["--content", fields["content"]]
        return args + _meta_args(metadata)

    def update(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        return cast(UpdateResponse, self._run(self._update_args(context_id, updates, id, index, metadata, fields)))

    async def aupdate(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        return cast(UpdateResponse, await self._arun(self._update_args(context_id, updates, id, index, metadata, fields)))

    # -- delete ---------------------------------------------------------------

    # permanent: uc delete <id> --permanent [--meta] -> {deleted, id}
    # soft: uc delete <id> --ids <i...> [--meta] -> {deleted, id, data, version}
    #   (the CLI's soft-delete envelope is a SUPERSET of remote {data, version},
    #    so it satisfies DeleteResponse at parity — see docs B4.)
    def _delete_args(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]],
        permanent: bool,
        metadata: Optional[Dict[str, Any]],
    ) -> List[str]:
        if permanent:
            if ids is not None:
                raise ValueError("Cannot pass both `ids` and `permanent=True`")
            return ["context", "delete", context_id, "--permanent", *_meta_args(metadata)]

        if ids is None:
            raise ValueError("Either `ids` (soft delete) or `permanent=True` (hard delete) is required")

        # each id/index becomes a SEPARATE argv item (no injection, no shell)
        items = ids if isinstance(ids, list) else [ids]
        return ["context", "delete", context_id, "--ids", *[str(i) for i in items], *_meta_args(metadata)]

    def delete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        return cast(
            Union[DeleteResponse, PermanentDeleteResponse],
            self._run(self._delete_args(context_id, ids, permanent, metadata)),
        )

    async def adelete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        return cast(
            Union[DeleteResponse, PermanentDeleteResponse],
            await self._arun(self._delete_args(context_id, ids, permanent, metadata)),
        )

    # -- delete_many ----------------------------------------------------------

    # no local delete-many verb — fan out permanent deletes, capturing per-id
    # errors into the row so the batch NEVER aborts. Returns {results, deleted_count}.
    def delete_many(self, ids: List[str]) -> DeleteManyResponse:
        results: List[DeleteManyResult] = []
        for cid in ids:
            try:
                self._run(["context", "delete", cid, "--permanent"])
                results.append({"id": cid, "deleted": True})
            except UltraContextError as exc:
                results.append({"id": cid, "deleted": False, "error": str(exc)})
        deleted_count = sum(1 for r in results if r["deleted"])
        return {"results": results, "deleted_count": deleted_count}

    async def adelete_many(self, ids: List[str]) -> DeleteManyResponse:
        results: List[DeleteManyResult] = []
        for cid in ids:
            try:
                await self._arun(["context", "delete", cid, "--permanent"])
                results.append({"id": cid, "deleted": True})
            except UltraContextError as exc:
                results.append({"id": cid, "deleted": False, "error": str(exc)})
        deleted_count = sum(1 for r in results if r["deleted"])
        return {"results": results, "deleted_count": deleted_count}
