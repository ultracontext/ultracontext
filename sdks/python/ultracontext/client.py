import json
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
        s3=None,
        native=None,
    ):
        self.mode = mode or ("remote" if api_key else "local")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.transport = transport or self._default_transport
        self.content_dir = content_dir
        self.inline_limit = inline_limit
        self.s3 = s3
        self.core = (
            self._load_native(native, path, content_dir, inline_limit, s3)
            if self.mode == "local"
            else None
        )
        self.workspaces = WorkspacesApi(self)
        self.sessions = SessionsApi(self)
        self.artifacts = WorkspaceArtifactsApi(self)
        self.fs = FileSystemApi(self)
        self.search = SearchApi(self)
        self.sync = SyncApi(self)

    def _call(self, operation, local_body, method="POST", path="/", remote_body=None):
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

    def _load_native(self, native, path, content_dir, inline_limit, s3):
        if native is None:
            try:
                from . import _native as native
            except ImportError as error:
                raise UltraContextError(
                    "local Python native mode requires the ultracontext native extension",
                    code="invalid_input",
                ) from error

        try:
            s3_json = None if s3 is None else json.dumps(s3)
            try:
                return native.UltraContextCore(path, content_dir, inline_limit, s3_json)
            except TypeError:
                if s3_json is not None:
                    raise
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


class WorkspacesApi:
    def __init__(self, client):
        self.client = client

    def create(self, input=None, **kwargs):
        body = metadata_body(input, kwargs)
        return self.client._call("create_workspace", body, "POST", "/v2/workspaces", body)

    def list(self):
        return self.client._call("list_workspaces", {}, "GET", "/v2/workspaces")


class SessionsApi:
    def __init__(self, client):
        self.client = client

    def create(self, input=None, **kwargs):
        input = dict(input or {})
        input.update(kwargs)
        workspace_id = input.pop("workspaceId", input.pop("workspace_id", None))
        body = metadata_body(input, {})
        if workspace_id:
            summary = self.client._call(
                "create_session",
                {"workspaceId": workspace_id, **body},
                "POST",
                f"/v2/workspaces/{workspace_id}/sessions",
                body,
            )
        else:
            summary = self.client._call("create", body, "POST", "/v2/contexts", body)
        return SessionHandle(self.client, summary)

    def get(self, session_id):
        if not session_id:
            raise UltraContextError("Missing session id", code="invalid_input")
        return SessionHandle(self.client, {"id": session_id})

    def list(self):
        return self.client._call("list_contexts", {}, "GET", "/v2/contexts")

    def delete(self, session_id):
        return self.client._call(
            "delete_context",
            {"ctxId": session_id},
            "POST",
            f"/v2/contexts/{session_id}/delete",
            {"target": {"permanent": True}},
        )

    def fork(self, source_id, **options):
        summary = self.client._call(
            "fork",
            {"sourceId": source_id, **options},
            "POST",
            f"/v2/contexts/{source_id}/fork",
            options,
        )
        return SessionHandle(self.client, summary)


class SessionHandle:
    def __init__(self, client, summary):
        self._client = client
        self._summary = dict(summary)
        for key, value in self._summary.items():
            setattr(self, key, value)
        self.context = SessionContextApi(client, self.id)
        self.artifacts = SessionArtifactsApi(client, self.id)
        self.fs = SessionFileSystemApi(client, self.id)

    def delete(self):
        return self._client.sessions.delete(self.id)

    def fork(self, **options):
        return self._client.sessions.fork(self.id, **options)

    def to_dict(self):
        return dict(self._summary)


class SessionContextApi:
    def __init__(self, client, session_id):
        self.client = client
        self.session_id = session_id

    def current(self, **options):
        return self.client._call(
            "get",
            {"ctxId": self.session_id, **options},
            "POST",
            f"/v2/contexts/{self.session_id}/get",
            options,
        )

    def get(self, **options):
        return self.current(**options)

    def list(self, **options):
        current = self.current(**options)
        return {
            "data": current.get("data", []),
            "context_id": current.get("context_id"),
            "version": current.get("version"),
        }

    def append(self, entries):
        if not isinstance(entries, list):
            entries = [entries]
        body = {"messages": entries}
        return self.client._call(
            "append",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/messages",
            body,
        )

    def update(self, update, **options):
        body = {"updates": update, **options}
        return self.client._call(
            "update",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/update",
            body,
        )

    def delete(self, target, **options):
        body = {"target": target, **options}
        return self.client._call(
            "delete_messages",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/delete",
            body,
        )

    def clear(self, **options):
        return self.client._call(
            "context_clear",
            {"ctxId": self.session_id, **options},
            "POST",
            f"/v2/contexts/{self.session_id}/clear",
            options,
        )

    def history(self):
        return self.client._call(
            "context_history",
            {"ctxId": self.session_id},
            "GET",
            f"/v2/contexts/{self.session_id}/history",
        )

    def restore(self, context_id, **options):
        body = {"contextId": context_id, **options}
        return self.client._call(
            "context_restore",
            {"ctxId": self.session_id, "restoreContextId": context_id, **options},
            "POST",
            f"/v2/contexts/{self.session_id}/restore",
            body,
        )


class SessionArtifactsApi:
    def __init__(self, client, session_id):
        self.client = client
        self.session_id = session_id

    def create(self, input):
        return self.client._call(
            "save",
            {"ctxId": self.session_id, **input},
            "POST",
            f"/v2/contexts/{self.session_id}/artifacts",
            input,
        )

    def list(self):
        return self.client._call(
            "list_artifacts",
            {"ctxId": self.session_id},
            "GET",
            f"/v2/contexts/{self.session_id}/artifacts",
        )

    def get(self, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self.client._call(
            "load",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/artifacts/load",
            body,
        )

    def update(self, path_or_id, data, **options):
        body = {"path": path_or_id, "data": data, **options}
        return self.client._call(
            "file_write",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/write",
            body,
        )

    def delete(self, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self.client._call(
            "file_remove",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/remove",
            body,
        )


class WorkspaceArtifactsApi:
    def __init__(self, client):
        self.client = client

    def session(self, session_id):
        return SessionArtifactsApi(self.client, session_id)


class FileSystemApi:
    def __init__(self, client):
        self.client = client

    def session(self, session_id):
        return SessionFileSystemApi(self.client, session_id)


class SessionFileSystemApi:
    def __init__(self, client, session_id):
        self.client = client
        self.session_id = session_id

    def list(self, **options):
        return self.client._call(
            "file_list",
            {"ctxId": self.session_id, **options},
            "GET",
            f"/v2/contexts/{self.session_id}/files",
        )

    def read(self, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self.client._call(
            "file_read",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/read",
            body,
        )

    def write(self, path, data, **options):
        body = {"path": path, "data": data, **options}
        return self.client._call(
            "file_write",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/write",
            body,
        )

    def move(self, from_path_or_id, to_path, **options):
        body = {"fromPathOrId": from_path_or_id, "toPath": to_path, **options}
        return self.client._call(
            "file_move",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/move",
            body,
        )

    def remove(self, path_or_id, **options):
        body = {"pathOrId": path_or_id, **options}
        return self.client._call(
            "file_remove",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/remove",
            body,
        )

    def glob(self, pattern, **options):
        body = {"pattern": pattern, **options}
        return self.client._call(
            "file_glob",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/glob",
            body,
        )

    def grep(self, query, **options):
        body = {"query": query, **options}
        return self.client._call(
            "file_grep",
            {"ctxId": self.session_id, **body},
            "POST",
            f"/v2/contexts/{self.session_id}/files/grep",
            body,
        )


class SyncApi:
    def __init__(self, client):
        self.client = client

    def export_snapshot(self):
        return self.client._call("export_snapshot", {}, "POST", "/v2/sync/export_snapshot", {})

    def import_snapshot(self, snapshot):
        return self.client._call(
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
        return self.client._call("export_changes", body, "POST", "/v2/sync/export_changes", body)

    def import_changes(self, changes):
        return self.client._call(
            "import_changes",
            changes,
            "POST",
            "/v2/sync/import_changes",
            changes,
        )


class SearchApi:
    def __init__(self, client):
        self.client = client

    def query(self, query, **options):
        body = {"query": query, **options}
        return self.client._call("search", body, "POST", "/v2/search", body)


def metadata_body(input, kwargs):
    input = dict(input or {})
    input.update(kwargs)
    metadata = input.pop("metadata", None)
    if metadata is not None:
        return {"metadata": metadata}
    return {"metadata": input}
