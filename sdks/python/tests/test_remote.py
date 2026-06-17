import json
import unittest

from ultracontext import UltraContext, UltraContextError


class RemoteClientTests(unittest.TestCase):
    def test_remote_client_sends_context_requests(self):
        calls = []

        def transport(method, url, headers, payload):
            calls.append((method, url, headers, payload))
            return 200, {"id": "ctx_abc", "metadata": {"app": "demo"}, "created_at": "now"}

        uc = UltraContext(
            mode="remote",
            api_key="uc_test_key",
            base_url="https://uc.example",
            transport=transport,
        )

        created = uc.create(metadata={"app": "demo"})

        self.assertEqual(created["id"], "ctx_abc")
        method, url, headers, payload = calls[0]
        self.assertEqual(method, "POST")
        self.assertEqual(url, "https://uc.example/v2/contexts")
        self.assertEqual(headers["authorization"], "Bearer uc_test_key")
        self.assertEqual(payload, b'{"metadata": {"app": "demo"}}')

    def test_remote_client_supports_messages_and_artifacts(self):
        calls = []

        def transport(method, url, headers, payload):
            calls.append((method, url, payload))
            if url.endswith("/messages"):
                return 200, {"data": [{"content": "hi"}], "version": 0}
            if url.endswith("/artifacts/load"):
                return 200, {"id": "art_abc", "path": "draft.md", "data": "# Draft"}
            return 200, {"id": "art_abc", "path": "draft.md", "version": 0}

        uc = UltraContext(mode="remote", base_url="https://uc.example", transport=transport)

        uc.append("ctx_abc", {"role": "user", "content": "hi"})
        uc.save("ctx_abc", {"path": "draft.md", "kind": "text/markdown", "data": "# Draft"})
        artifact = uc.load("ctx_abc", "draft.md")

        self.assertEqual(artifact["data"], "# Draft")
        self.assertEqual(calls[0][1], "https://uc.example/v2/contexts/ctx_abc/messages")
        self.assertEqual(
            json.loads(calls[0][2].decode("utf-8")),
            {"messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(calls[1][1], "https://uc.example/v2/contexts/ctx_abc/artifacts")
        self.assertEqual(calls[2][1], "https://uc.example/v2/contexts/ctx_abc/artifacts/load")

    def test_remote_errors_preserve_code_and_status(self):
        def transport(method, url, headers, payload):
            return 404, {"error": {"code": "not_found", "message": "Context not found"}}

        uc = UltraContext(mode="remote", base_url="https://uc.example", transport=transport)

        with self.assertRaises(UltraContextError) as error:
            uc.get("ctx_missing")

        self.assertEqual(error.exception.code, "not_found")
        self.assertEqual(error.exception.status, 404)
        self.assertEqual(str(error.exception), "Context not found")


if __name__ == "__main__":
    unittest.main()
