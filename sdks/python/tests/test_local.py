import json
import unittest

from ultracontext import UltraContext, UltraContextError


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

    def UltraContextCore(self, path, content_dir=None, inline_limit=None):
        self.path = path
        self.content_dir = content_dir
        self.inline_limit = inline_limit
        return self.core


class LocalClientTests(unittest.TestCase):
    def test_local_client_dispatches_to_native_core(self):
        core = FakeCore()
        native = FakeNative(core)
        uc = UltraContext(mode="local", path="/tmp/uc.db", native=native)

        ctx = uc.create(metadata={"app": "demo"})
        artifact = uc.write(ctx["id"], "draft.md", "# Draft", kind="text/markdown")

        self.assertEqual(native.path, "/tmp/uc.db")
        self.assertEqual(ctx["id"], "ses_local")
        self.assertEqual(artifact["id"], "art_local")
        self.assertEqual(core.calls[0], ("create", {"metadata": {"app": "demo"}}))
        self.assertEqual(core.calls[1][0], "file_write")
        self.assertEqual(core.calls[1][1]["ctxId"], "ses_local")
        self.assertEqual(core.calls[1][1]["path"], "draft.md")

    def test_local_client_maps_native_error_envelope(self):
        uc = UltraContext(mode="local", native=FakeNative(FakeCore()))

        with self.assertRaises(UltraContextError) as error:
            uc.get("ctx_missing")

        self.assertEqual(error.exception.code, "not_found")
        self.assertEqual(str(error.exception), "missing")


if __name__ == "__main__":
    unittest.main()
