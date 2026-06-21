import json
import tempfile
from pathlib import Path
import unittest

from ultracontext import UltraContext, UltraContextError, create_client


class FakeCore:
    def __init__(self):
        self.calls = []

    def dispatch_json(self, operation, payload):
        body = json.loads(payload)
        self.calls.append((operation, body))
        if operation == "create":
            return json.dumps(
                {
                    "ok": {
                        "id": "ses_local",
                        "metadata": body["metadata"],
                        "created_at": "now",
                    }
                }
            )
        if operation == "file_write":
            return json.dumps(
                {
                    "ok": {
                        "id": "art_local",
                        "path": body["path"],
                        "kind": body.get("kind", "text/plain"),
                        "version": 0,
                    }
                }
            )
        return json.dumps({"error": {"code": "not_found", "message": "missing"}})


class FakeNative:
    def __init__(self, core):
        self.core = core

    def UltraContextCore(self, path, content_dir=None, inline_limit=None, s3=None):
        self.path = path
        self.content_dir = content_dir
        self.inline_limit = inline_limit
        self.s3 = s3
        return self.core


class LocalClientTests(unittest.TestCase):
    def test_local_client_dispatches_to_native_core(self):
        core = FakeCore()
        native = FakeNative(core)
        uc = UltraContext(mode="local", path="/tmp/uc.db", native=native)

        ctx = uc.sessions.create(metadata={"app": "demo"})
        artifact = ctx.fs.write("draft.md", "# Draft", kind="text/markdown")

        self.assertEqual(native.path, "/tmp/uc.db")
        self.assertEqual(ctx.id, "ses_local")
        self.assertEqual(artifact["id"], "art_local")
        self.assertEqual(core.calls[0], ("create", {"metadata": {"app": "demo"}}))
        self.assertEqual(core.calls[1][0], "file_write")
        self.assertEqual(core.calls[1][1]["ctxId"], "ses_local")
        self.assertEqual(core.calls[1][1]["path"], "draft.md")

    def test_local_client_maps_native_error_envelope(self):
        uc = UltraContext(mode="local", native=FakeNative(FakeCore()))

        with self.assertRaises(UltraContextError) as error:
            uc.sessions.get("ctx_missing").context.current()

        self.assertEqual(error.exception.code, "not_found")
        self.assertEqual(str(error.exception), "missing")

    def test_local_client_passes_s3_config_to_native_core(self):
        native = FakeNative(FakeCore())
        UltraContext(
            mode="local",
            path="/tmp/uc-s3.db",
            native=native,
            inline_limit=123,
            s3={
                "endpoint": "https://r2.example",
                "bucket": "uc",
                "region": "auto",
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "prefix": "project-a",
            },
        )

        self.assertEqual(native.inline_limit, 123)
        self.assertEqual(
            json.loads(native.s3),
            {
                "endpoint": "https://r2.example",
                "bucket": "uc",
                "region": "auto",
                "accessKeyId": "key",
                "secretAccessKey": "secret",
                "prefix": "project-a",
            },
        )

    def test_create_client_reads_project_config(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "ultracontext.json").write_text(
                json.dumps(
                    {
                        "db": ".ultracontext/ultracontext.db",
                        "storage": {
                            "contentDir": ".ultracontext/blobs",
                            "inlineLimit": 456,
                        },
                    }
                ),
                encoding="utf-8",
            )
            native = FakeNative(FakeCore())

            uc = create_client(project_root=root, native=native)
            resolved_root = Path(root).resolve()

            self.assertEqual(native.path, str(resolved_root / ".ultracontext/ultracontext.db"))
            self.assertEqual(native.content_dir, str(resolved_root / ".ultracontext/blobs"))
            self.assertEqual(native.inline_limit, 456)
            self.assertEqual(uc.mode, "local")

    def test_create_client_reads_s3_project_config(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "ultracontext.json").write_text(
                json.dumps(
                    {
                        "db": ".ultracontext/ultracontext.db",
                        "storage": {
                            "driver": "s3",
                            "inlineLimit": 789,
                            "s3": {
                                "endpoint": "https://r2.example",
                                "bucket": "uc",
                                "region": "auto",
                                "accessKeyId": "key",
                                "secretAccessKey": "secret",
                                "prefix": "project-a",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            native = FakeNative(FakeCore())

            uc = create_client(project_root=root, native=native)

            self.assertEqual(uc.mode, "local")
            self.assertEqual(native.content_dir, None)
            self.assertEqual(native.inline_limit, 789)
            self.assertEqual(
                json.loads(native.s3),
                {
                    "endpoint": "https://r2.example",
                    "bucket": "uc",
                    "region": "auto",
                    "accessKeyId": "key",
                    "secretAccessKey": "secret",
                    "prefix": "project-a",
                },
            )


if __name__ == "__main__":
    unittest.main()
