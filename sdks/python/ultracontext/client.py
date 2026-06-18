import json
from pathlib import Path
import urllib.error
import urllib.request


class UltraContextError(Exception):
    def __init__(self, message, *, code="internal", status=None, body=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.body = body


class UltraContext:
    def __init__(
        self,
        api_key=None,
        *,
        mode=None,
        base_url="https://api.ultracontext.ai",
        transport=None,
        path="ultracontext.db",
        content_dir=None,
        inline_limit=None,
        native=None,
    ):
        self.mode = mode or ("remote" if api_key else "local")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.transport = transport or self._default_transport
        self.content_dir = content_dir
        self.inline_limit = inline_limit
        self.core = (
            self._load_native(native, path, content_dir, inline_limit)
            if self.mode == "local"
            else None
        )

    def create_workspace(self, input=None, **kwargs):
        metadata = kwargs.pop("metadata", None)
        if input is None:
            input = {}
        if metadata is not None:
            input = {"metadata": metadata}
        elif "metadata" not in input:
            input = {"metadata": input}
        return self._call("create_workspace", input, "POST", "/v2/workspaces", input)

    def list_workspaces(self):
        return self._call("list_workspaces", {}, "GET", "/v2/workspaces")

    def create_session(self, workspace_id, input=None, **kwargs):
        metadata = kwargs.pop("metadata", None)
        if input is None:
            input = {}
        if metadata is not None:
            input = {"metadata": metadata}
        elif "metadata" not in input:
            input = {"metadata": input}
        local = {"workspaceId": workspace_id, **input}
        return self._call(
            "create_session",
            local,
            "POST",
            f"/v2/workspaces/{workspace_id}/sessions",
            input,
        )

    def create(self, input=None, **kwargs):
        metadata = kwargs.pop("metadata", None)
        workspace_id = kwargs.pop("workspaceId", kwargs.pop("workspace_id", None))
        if input is None:
            input = {}
        if isinstance(input, dict):
            workspace_id = input.get("workspaceId", input.get("workspace_id", workspace_id))
        if metadata is not None:
            input = {"metadata": metadata}
        elif "metadata" not in input:
            input = {"metadata": input}
        if workspace_id is not None:
            input = {**input, "workspaceId": workspace_id}
        return self._call("create", input, "POST", "/v2/contexts", input)

    def fork(self, source_id, **options):
        local = {"sourceId": source_id, **options}
        return self._call("fork", local, "POST", f"/v2/contexts/{source_id}/fork", options)

    def append(self, context_id, messages):
        if not isinstance(messages, list):
            messages = [messages]
        body = {"messages": messages}
        return self._call(
            "append",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/messages",
            body,
        )

    def get(self, context_id=None, **options):
        if context_id is None:
            return self._call("list_contexts", {}, "GET", "/v2/contexts")
        return self._call(
            "get",
            {"ctxId": context_id, **options},
            "POST",
            f"/v2/contexts/{context_id}/get",
            options,
        )

    def update(self, context_id, updates=None, **options):
        body = {"updates": updates, **options}
        return self._call(
            "update",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/update",
            body,
        )

    def delete(self, context_id, target=None, **options):
        body = {"target": target, **options}
        return self._call(
            "delete",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/delete",
            body,
        )

    def search(self, query, **options):
        body = {"query": query, **options}
        return self._call("search", body, "POST", "/v2/search", body)

    def save(self, context_id, input):
        return self._call(
            "save",
            {"ctxId": context_id, **input},
            "POST",
            f"/v2/contexts/{context_id}/artifacts",
            input,
        )

    def load(self, context_id, path_or_id=None, **options):
        if path_or_id is None:
            return self._call(
                "list_artifacts",
                {"ctxId": context_id},
                "GET",
                f"/v2/contexts/{context_id}/artifacts",
            )
        body = {"pathOrId": path_or_id, **options}
        return self._call(
            "load",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/artifacts/load",
            body,
        )

    def read(self, context_id, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self._call(
            "file_read",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/read",
            body,
        )

    def write(self, context_id, path, data, **options):
        body = {"path": path, "data": data, **options}
        return self._call(
            "file_write",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/write",
            body,
        )

    def move(self, context_id, from_path_or_id, to_path, **options):
        body = {"fromPathOrId": from_path_or_id, "toPath": to_path, **options}
        return self._call(
            "file_move",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/move",
            body,
        )

    def remove(self, context_id, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self._call(
            "file_remove",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/remove",
            body,
        )

    def glob(self, context_id, pattern, **options):
        body = {"pattern": pattern, **options}
        return self._call(
            "file_glob",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/glob",
            body,
        )

    def grep(self, context_id, query, **options):
        body = {"query": query, **options}
        return self._call(
            "file_grep",
            {"ctxId": context_id, **body},
            "POST",
            f"/v2/contexts/{context_id}/files/grep",
            body,
        )

    def materialize(self, context_id, directory, *, prefix=None):
        directory = Path(directory)
        prefix = _normalize_prefix(prefix)
        artifacts = self.load(context_id).get("data", [])
        written = []
        for artifact in artifacts:
            path = artifact["path"]
            if prefix and not path.startswith(prefix):
                continue
            loaded = self.read(context_id, artifact["id"])
            if loaded.get("data") is None:
                continue
            file = _safe_join(directory, path)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(loaded["data"])
            written.append(
                {
                    "path": path,
                    "file": str(file),
                    "id": artifact["id"],
                    "version": loaded["version"],
                }
            )
        return {"data": written}

    def sync_directory(self, context_id, directory, *, prefix=None, kind_by_path=None):
        directory = Path(directory)
        prefix = _normalize_prefix(prefix)
        synced = []
        for file in sorted(path for path in directory.rglob("*") if path.is_file()):
            path = file.relative_to(directory).as_posix()
            if prefix and not path.startswith(prefix):
                continue
            saved = self.write(
                context_id,
                path,
                file.read_text(),
                kind=_kind_for_path(path, kind_by_path),
            )
            synced.append(
                {
                    "path": saved["path"],
                    "file": str(file),
                    "id": saved["id"],
                    "version": saved["version"],
                }
            )
        return {"data": synced}

    def export_snapshot(self):
        return self._call(
            "export_snapshot",
            {},
            "POST",
            "/v2/sync/export_snapshot",
            {},
        )

    def import_snapshot(self, snapshot):
        return self._call(
            "import_snapshot",
            snapshot,
            "POST",
            "/v2/sync/import_snapshot",
            snapshot,
        )

    def export_changes(self, since=None):
        body = {}
        if since is not None:
            body["since"] = since
        return self._call(
            "export_changes",
            body,
            "POST",
            "/v2/sync/export_changes",
            body,
        )

    def import_changes(self, changes):
        return self._call(
            "import_changes",
            changes,
            "POST",
            "/v2/sync/import_changes",
            changes,
        )

    def _call(self, operation, local_body, method, path, remote_body=None):
        if self.mode == "local":
            return self._call_local(operation, local_body)
        return self._request(method, path, remote_body)

    def _call_local(self, operation, body):
        payload = json.dumps(body)
        envelope = json.loads(self.core.dispatch_json(operation, payload))
        if "error" in envelope:
            error = envelope["error"]
            raise UltraContextError(
                error.get("message", "UltraContext request failed"),
                code=error.get("code", "internal"),
                body=envelope,
            )
        return envelope.get("ok")

    def _request(self, method, path, body=None):
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"

        payload = None if body is None else json.dumps(body).encode("utf-8")
        status, response_body = self.transport(
            method,
            f"{self.base_url}{path}",
            headers,
            payload,
        )

        if status < 200 or status >= 300:
            error = (response_body or {}).get("error", response_body or {})
            raise UltraContextError(
                error.get("message", "UltraContext request failed"),
                code=error.get("code", "internal"),
                status=status,
                body=response_body,
            )

        return response_body

    def _load_native(self, native, path, content_dir, inline_limit):
        if native is None:
            try:
                from . import _native as native
            except ImportError as error:
                raise UltraContextError(
                    "local Python native mode requires the ultracontext native extension",
                    code="invalid_input",
                ) from error

        try:
            return native.UltraContextCore(path, content_dir, inline_limit)
        except Exception as error:
            raise UltraContextError(str(error), code="internal") from error

    def _default_transport(self, method, url, headers, payload):
        request = urllib.request.Request(
            url,
            data=payload,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request) as response:
                text = response.read().decode("utf-8")
                return response.status, json.loads(text) if text else None
        except urllib.error.HTTPError as error:
            text = error.read().decode("utf-8")
            return error.code, json.loads(text) if text else None


def _safe_join(root, path):
    if not path or path.startswith("/") or ".." in Path(path).parts:
        raise UltraContextError(f"Invalid materialized path: {path}", code="invalid_input")
    return root.joinpath(*path.split("/"))


def _normalize_prefix(prefix):
    if not prefix:
        return ""
    return str(prefix).strip("/")


def _kind_for_path(path, kind_by_path):
    if kind_by_path is not None:
        return kind_by_path(path)
    if path.endswith(".md"):
        return "text/markdown"
    if path.endswith(".json"):
        return "application/json"
    if path.endswith(".txt"):
        return "text/plain"
    return "text/plain"
