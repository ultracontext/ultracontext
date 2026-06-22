import json
import unittest

from ultracontext import UltraContext, UltraContextError, create_client


class RemoteClientTests(unittest.TestCase):
    def test_create_client_supports_remote_mode(self):
        calls = []

        def transport(method, url, headers, payload):
            calls.append((method, url, headers, payload))
            return 200, {"data": []}

        uc = create_client(
            "uc_test_key",
            base_url="https://uc.example",
            transport=transport,
        )

        uc.sessions.list()

        self.assertEqual(uc.mode, "remote")
        self.assertEqual(calls[0][1], "https://uc.example/v2/contexts")
        self.assertEqual(calls[0][2]["authorization"], "Bearer uc_test_key")

    def test_remote_client_sends_context_requests(self):
        calls = []

        def transport(method, url, headers, payload):
            calls.append((method, url, headers, payload))
            return 200, {"id": "ses_abc", "metadata": {"app": "demo"}, "created_at": "now"}

        uc = UltraContext(
            mode="remote",
            api_key="uc_test_key",
            base_url="https://uc.example",
            transport=transport,
        )

        created = uc.sessions.create(metadata={"app": "demo"})

        self.assertEqual(created.id, "ses_abc")
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

        session = uc.sessions.get("ses_abc")
        session.context.append({"role": "user", "content": "hi"})
        session.artifacts.create({"path": "draft.md", "kind": "text/markdown", "data": "# Draft"})
        artifact = session.artifacts.get("draft.md")

        self.assertEqual(artifact["data"], "# Draft")
        self.assertEqual(calls[0][1], "https://uc.example/v2/contexts/ses_abc/messages")
        self.assertEqual(
            json.loads(calls[0][2].decode("utf-8")),
            {"messages": [{"role": "user", "content": "hi"}]},
        )
        self.assertEqual(calls[1][1], "https://uc.example/v2/contexts/ses_abc/artifacts")
        self.assertEqual(calls[2][1], "https://uc.example/v2/contexts/ses_abc/artifacts/load")

    def test_remote_client_supports_context_window_operations(self):
        calls = []

        def transport(method, url, headers, payload):
            calls.append((method, url, payload))
            if url.endswith("/history"):
                return 200, {
                    "data": [
                        {
                            "id": "ctx_v1",
                            "session_id": "ses_abc",
                            "version": 1,
                            "operation": "update",
                            "created_at": "now",
                            "current": True,
                        }
                    ]
                }
            return 200, {"context_id": "ctx_v2", "data": [], "version": 2}

        uc = UltraContext(mode="remote", base_url="https://uc.example", transport=transport)

        session = uc.sessions.get("ses_abc")
        history = session.context.history()
        session.context.clear(metadata={"reason": "reset"})
        session.context.restore("ctx_v1", metadata={"reason": "time travel"})

        self.assertEqual(history["data"][0]["id"], "ctx_v1")
        self.assertEqual(calls[0][0], "GET")
        self.assertEqual(calls[0][1], "https://uc.example/v2/contexts/ses_abc/history")
        self.assertEqual(calls[1][1], "https://uc.example/v2/contexts/ses_abc/clear")
        self.assertEqual(
            json.loads(calls[1][2].decode("utf-8")),
            {"metadata": {"reason": "reset"}},
        )
        self.assertEqual(calls[2][1], "https://uc.example/v2/contexts/ses_abc/restore")
        self.assertEqual(
            json.loads(calls[2][2].decode("utf-8")),
            {"contextId": "ctx_v1", "metadata": {"reason": "time travel"}},
        )

    def test_remote_errors_preserve_code_and_status(self):
        def transport(method, url, headers, payload):
            return 404, {"error": {"code": "not_found", "message": "Context not found"}}

        uc = UltraContext(mode="remote", base_url="https://uc.example", transport=transport)

        with self.assertRaises(UltraContextError) as error:
            uc.sessions.get("ctx_missing").context.get()

        self.assertEqual(error.exception.code, "not_found")
        self.assertEqual(error.exception.status, 404)
        self.assertEqual(str(error.exception), "Context not found")


if __name__ == "__main__":
    unittest.main()
