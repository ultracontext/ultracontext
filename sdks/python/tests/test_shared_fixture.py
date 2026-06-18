import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from ultracontext import UltraContext, UltraContextError


FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "fixtures" / "v2-alpha.json").read_text()
)


def load_native():
    try:
        from ultracontext import _native
    except ImportError:
        return None
    return _native


class NativeHttpTransport:
    def __init__(self, core):
        self.core = core

    def __call__(self, method, url, headers, payload):
        try:
            body = json.loads(payload.decode("utf-8")) if payload else {}
            path = urlparse(url).path
            output = self.dispatch(method, path, body)
            return 200, output
        except UltraContextError as error:
            return self.status(error.code), {
                "error": {"code": error.code, "message": str(error)}
            }

    def dispatch(self, method, path, body):
        segments = [segment for segment in path.split("/") if segment]
        if segments[:2] == ["v2", "search"] and method == "POST":
            return self.call("search", body)
        if segments[:2] == ["v2", "workspaces"]:
            if method == "POST" and len(segments) == 2:
                return self.call("create_workspace", body)
            if method == "GET" and len(segments) == 2:
                return self.call("list_workspaces", {})
            if method == "POST" and len(segments) == 4 and segments[3] == "sessions":
                return self.call("create_session", {"workspaceId": segments[2], **body})
            raise UltraContextError("Route not found", code="not_found")
        if segments[:2] != ["v2", "contexts"]:
            raise UltraContextError("Route not found", code="not_found")
        if method == "POST" and len(segments) == 2:
            return self.call("create", body)
        if method == "GET" and len(segments) == 2:
            return self.call("list_contexts", {})

        context_id = segments[2]
        action = segments[3] if len(segments) > 3 else None
        nested = segments[4] if len(segments) > 4 else None

        if method == "POST" and action == "fork":
            return self.call("fork", {"sourceId": context_id, **body})
        if method == "POST" and action == "messages":
            messages = body.get("messages", body)
            if not isinstance(messages, list):
                messages = [messages]
            return self.call("append", {"ctxId": context_id, "messages": messages})
        if method == "POST" and action == "get":
            return self.call("get", {"ctxId": context_id, **body})
        if method == "POST" and action == "update":
            return self.call("update", {"ctxId": context_id, **body})
        if method == "POST" and action == "delete":
            return self.call("delete", {"ctxId": context_id, **body})
        if action == "artifacts" and method == "GET":
            return self.call("list_artifacts", {"ctxId": context_id})
        if action == "artifacts" and method == "POST" and nested is None:
            return self.call("save", {"ctxId": context_id, **body})
        if action == "artifacts" and method == "POST" and nested == "load":
            return self.call("load", {"ctxId": context_id, **body})
        if action == "files" and method == "POST":
            operation = {
                "read": "file_read",
                "write": "file_write",
                "move": "file_move",
                "remove": "file_remove",
                "glob": "file_glob",
                "grep": "file_grep",
            }.get(nested)
            if operation:
                return self.call(operation, {"ctxId": context_id, **body})

        raise UltraContextError("Route not found", code="not_found")

    def call(self, operation, body):
        envelope = json.loads(self.core.dispatch_json(operation, json.dumps(body)))
        if "error" in envelope:
            error = envelope["error"]
            raise UltraContextError(
                error.get("message", "UltraContext request failed"),
                code=error.get("code", "internal"),
            )
        return envelope["ok"]

    @staticmethod
    def status(code):
        return {
            "not_found": 404,
            "invalid_input": 400,
            "conflict": 409,
            "busy": 503,
        }.get(code, 500)


def run_shared_fixture(testcase, uc, legacy_context_id=False):
    ctx = uc.create(metadata=FIXTURE["metadata"])
    prefixes = ("ses_", "ctx_") if legacy_context_id else ("ses_",)
    testcase.assertTrue(ctx["id"].startswith(prefixes))

    appended = uc.append(ctx["id"], FIXTURE["messages"])
    testcase.assertEqual(appended["version"], 0)
    testcase.assertEqual(len(appended["data"]), 2)

    updated = uc.update(ctx["id"], FIXTURE["message_update"])
    testcase.assertEqual(updated["version"], 1)
    testcase.assertEqual(updated["data"][1]["content"], "fixture draft ready!")

    fork = uc.fork(ctx["id"], version=0, metadata={"suite": "fork"})
    forked = uc.get(fork["id"], version=0)
    testcase.assertEqual(forked["data"][1]["content"], "fixture draft ready")

    written = uc.write(
        ctx["id"],
        FIXTURE["artifact"]["path"],
        FIXTURE["artifact"]["initial"],
        kind=FIXTURE["artifact"]["kind"],
    )
    testcase.assertEqual(written["version"], 0)

    with testcase.assertRaises(UltraContextError) as conflict:
        uc.write(
            ctx["id"],
            FIXTURE["artifact"]["path"],
            FIXTURE["artifact"]["final"],
            kind=FIXTURE["artifact"]["kind"],
            ifVersion=written["version"] + 1,
        )
    testcase.assertEqual(conflict.exception.code, "conflict")

    saved = uc.save(
        ctx["id"],
        {
            "id": written["id"],
            "path": FIXTURE["artifact"]["renamed_path"],
            "kind": FIXTURE["artifact"]["kind"],
            "data": FIXTURE["artifact"]["final"],
            "ifVersion": written["version"],
        },
    )
    testcase.assertEqual(saved["id"], written["id"])
    testcase.assertEqual(saved["version"], 1)

    old = uc.read(ctx["id"], written["id"], version=0)
    testcase.assertEqual(old["path"], FIXTURE["artifact"]["path"])
    testcase.assertEqual(old["data"], FIXTURE["artifact"]["initial"])

    files = uc.load(ctx["id"])
    testcase.assertEqual(files["data"][0]["path"], FIXTURE["artifact"]["renamed_path"])

    listed = uc.glob(ctx["id"], "notes/*.md")
    testcase.assertEqual(len(listed["data"]), 1)

    grep = uc.grep(ctx["id"], FIXTURE["search_query"], prefix="notes")
    testcase.assertEqual(grep["data"][0]["kind"], "artifact")

    search = uc.search(FIXTURE["search_query"])
    testcase.assertTrue(any(hit["kind"] == "message" for hit in search["data"]))

    uc.remove(ctx["id"], FIXTURE["artifact"]["renamed_path"], ifVersion=saved["version"])
    with testcase.assertRaises(UltraContextError) as missing_artifact:
        uc.read(ctx["id"], FIXTURE["artifact"]["renamed_path"])
    testcase.assertEqual(missing_artifact.exception.code, "not_found")

    with testcase.assertRaises(UltraContextError) as missing_context:
        uc.get(FIXTURE["missing_context"])
    testcase.assertEqual(missing_context.exception.code, "not_found")


class SharedFixtureTests(unittest.TestCase):
    def test_shared_v2_alpha_fixture_passes_through_python_local_native(self):
        native = load_native()
        if native is None:
            self.skipTest("native extension is not installed")

        with tempfile.NamedTemporaryFile(suffix=".db") as db:
            uc = UltraContext(mode="local", path=db.name, native=native)
            run_shared_fixture(self, uc, legacy_context_id=True)

    def test_shared_v2_alpha_fixture_passes_through_python_remote_transport(self):
        native = load_native()
        if native is None:
            self.skipTest("native extension is not installed")

        with tempfile.NamedTemporaryFile(suffix=".db") as db:
            core = native.UltraContextCore(db.name)
            uc = UltraContext(
                mode="remote",
                base_url="https://uc.local",
                transport=NativeHttpTransport(core),
            )
            run_shared_fixture(self, uc)

    def test_python_local_native_can_use_local_dir_content_store(self):
        native = load_native()
        if native is None:
            self.skipTest("native extension is not installed")

        with tempfile.NamedTemporaryFile(suffix=".db") as db:
            with tempfile.TemporaryDirectory() as content_dir:
                uc = UltraContext(
                    mode="local",
                    path=db.name,
                    native=native,
                    content_dir=content_dir,
                    inline_limit=4,
                )
                ctx = uc.create(metadata={"app": "native-content-test"})
                uc.write(
                    ctx["id"],
                    "large.md",
                    "larger than four bytes",
                    kind="text/markdown",
                )
                read = uc.read(ctx["id"], "large.md")

                self.assertEqual(read["data"], "larger than four bytes")
                self.assertEqual(read["storage"]["type"], "ref")
                self.assertEqual(read["storage"]["driver"], "local-dir")
                self.assertTrue((Path(content_dir) / read["storage"]["key"]).exists())

    def test_python_sdk_can_materialize_and_sync_directory_edits(self):
        native = load_native()
        if native is None:
            self.skipTest("native extension is not installed")

        with tempfile.NamedTemporaryFile(suffix=".db") as db:
            with tempfile.TemporaryDirectory() as directory:
                uc = UltraContext(mode="local", path=db.name, native=native)
                ctx = uc.create(metadata={"app": "materialize"})
                uc.write(ctx["id"], "notes/draft.md", "# Draft", kind="text/markdown")

                materialized = uc.materialize(ctx["id"], directory)
                self.assertEqual(materialized["data"][0]["path"], "notes/draft.md")
                draft = Path(directory) / "notes" / "draft.md"
                self.assertEqual(draft.read_text(), "# Draft")

                draft.write_text("# Final")
                synced = uc.sync_directory(ctx["id"], directory)
                self.assertEqual(synced["data"][0]["path"], "notes/draft.md")

                read = uc.read(ctx["id"], "notes/draft.md")
                self.assertEqual(read["data"], "# Final")
                self.assertEqual(read["version"], 1)

    def test_python_sdk_can_export_and_import_incremental_changes(self):
        native = load_native()
        if native is None:
            self.skipTest("native extension is not installed")

        with tempfile.NamedTemporaryFile(suffix=".db") as source_db:
            with tempfile.NamedTemporaryFile(suffix=".db") as mirror_db:
                source = UltraContext(mode="local", path=source_db.name, native=native)
                mirror = UltraContext(mode="local", path=mirror_db.name, native=native)
                ctx = source.create(metadata={"app": "sync"})
                source.append(ctx["id"], {"content": "base"})

                snapshot = source.export_snapshot()
                cursor = snapshot["cursor"]
                mirror.import_snapshot(snapshot)

                source.append(ctx["id"], {"content": "next"})
                source.write(
                    ctx["id"],
                    "sync.md",
                    "synced content",
                    kind="text/markdown",
                )
                changes = source.export_changes(since=cursor)
                report = mirror.import_changes(changes)

                self.assertGreater(report["imported"], 0)
                self.assertEqual(report["conflicts"], [])
                self.assertEqual(mirror.get(ctx["id"])["data"][1]["content"], "next")
                self.assertEqual(mirror.read(ctx["id"], "sync.md")["data"], "synced content")


if __name__ == "__main__":
    unittest.main()
