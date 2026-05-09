import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path


TEST_FILE = Path(__file__).resolve()
REPO_PLUGIN_DIR = TEST_FILE.parents[3] / "plugins" / "hermes"
INSTALLED_PLUGIN_DIR = TEST_FILE.parents[1]
PLUGIN_DIR = REPO_PLUGIN_DIR if REPO_PLUGIN_DIR.exists() else INSTALLED_PLUGIN_DIR
PLUGIN_PATH = PLUGIN_DIR / "__init__.py"
MANIFEST_PATH = PLUGIN_DIR / "plugin.yaml"


@contextmanager
def patched_env(**values):
    old = {key: os.environ.get(key) for key in values}
    for key, value in values.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = str(value)
    try:
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def load_plugin():
    spec = importlib.util.spec_from_file_location("uc_hermes_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def make_fake_uc(tmp_path: Path, output: str, exit_code: int = 0) -> Path:
    log_path = tmp_path / "uc.args"
    fake_uc = tmp_path / "uc"
    fake_uc.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        f"pathlib.Path({str(log_path)!r}).write_text(' '.join(sys.argv[1:]) + '\\n')\n"
        f"sys.stdout.write({output!r})\n"
        f"sys.exit({exit_code})\n"
    )
    fake_uc.chmod(fake_uc.stat().st_mode | stat.S_IXUSR)
    return fake_uc


def make_fake_uc_from_file(tmp_path: Path, output_path: Path) -> Path:
    log_path = tmp_path / "uc.args"
    fake_uc = tmp_path / "uc"
    fake_uc.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        f"pathlib.Path({str(log_path)!r}).write_text(' '.join(sys.argv[1:]) + '\\n')\n"
        f"sys.stdout.write(pathlib.Path({str(output_path)!r}).read_text())\n"
    )
    fake_uc.chmod(fake_uc.stat().st_mode | stat.S_IXUSR)
    return fake_uc


class HermesUltraContextPluginTests(unittest.TestCase):
    def test_register_wires_pre_llm_call_hook(self):
        plugin = load_plugin()
        registered = []

        class Ctx:
            def register_hook(self, name, callback):
                registered.append((name, callback))

        plugin.register(Ctx())

        self.assertEqual(len(registered), 1)
        self.assertEqual(registered[0][0], "pre_llm_call")
        self.assertIs(registered[0][1], plugin.on_pre_llm_call)

    def test_pre_llm_call_injects_only_events_since_previous_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            output_path = tmp_path / "events.jsonl"
            event_a = '{"event_id":"a","kind":"chatgpt.app.closed","subject":"chatgpt:app:ios","labels":{"app":"chatgpt"},"counts":{"changed_sessions":0,"synced":0,"failed":0}}\n'
            event_b = '{"event_id":"b","kind":"chatgpt.session.updated","subject":"chatgpt:session:new","payload_ref":"file:///tmp/new.md","labels":{"title":"Semente Funcionou"},"counts":{"message_count":10}}\n'
            output_path.write_text(event_a)
            fake_uc = make_fake_uc_from_file(tmp_path, output_path)
            state_path = tmp_path / "state.json"

            with patched_env(
                ULTRACONTEXT_CLI=str(fake_uc),
                ULTRACONTEXT_HERMES_STATE_FILE=str(state_path),
            ):
                plugin = load_plugin()
                self.assertIsNone(plugin.on_pre_llm_call(session_id="s1", user_message="primeiro turno"))
                output_path.write_text(event_a + event_b)
                result = plugin.on_pre_llm_call(session_id="s1", user_message="segundo turno")

            self.assertIsInstance(result, dict)
            context = result["context"]
            self.assertIn("chatgpt.session.updated", context)
            self.assertIn("Semente Funcionou", context)
            self.assertIn("file:///tmp/new.md", context)
            self.assertNotIn("chatgpt.app.closed", context)

    def test_pre_llm_call_injects_compact_recent_uc_events_without_running_deep_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_uc = make_fake_uc(
                tmp_path,
                '{"event_id":"baseline","kind":"baseline"}\n'
                '{"event_id":"a","schema_version":"uc.event.v1","kind":"chatgpt.session.updated","subject":"chatgpt:session:abc","payload_ref":"file:///tmp/abc.md","labels":{"title":"Driver design"}}\n'
                '{"event_id":"b","schema_version":"uc.event.v1","kind":"claude.session.updated","subject":"claude:session:def","labels":{"title":"Update flow"}}\n',
            )
            state_path = tmp_path / "state.json"
            state_path.write_text(json.dumps({"s1": "baseline"}))
            with patched_env(
                ULTRACONTEXT_CLI=str(fake_uc),
                ULTRACONTEXT_HERMES_EVENT_LIMIT="7",
                ULTRACONTEXT_HERMES_TIMEOUT_SECONDS="2",
                ULTRACONTEXT_HERMES_STATE_FILE=str(state_path),
            ):
                plugin = load_plugin()
                result = plugin.on_pre_llm_call(
                    session_id="s1",
                    user_message="continua a arquitetura nova",
                    platform="telegram",
                )

            self.assertIsInstance(result, dict)
            context = result["context"]
            self.assertIn("UltraContext activity signal", context)
            self.assertIn("chatgpt.session.updated", context)
            self.assertIn("Driver design", context)
            self.assertIn("file:///tmp/abc.md", context)
            self.assertIn("claude.session.updated", context)
            self.assertIn("uc event query", context)
            self.assertNotIn("schema_version", context)
            self.assertNotIn("raw_path", context)
            self.assertEqual((tmp_path / "uc.args").read_text(), "event tail --limit 7\n")

    def test_pre_llm_call_bounds_injected_context_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            huge_output = "baseline\n" + "\n".join(f"event-{i} " + "x" * 200 for i in range(100))
            fake_uc = make_fake_uc(tmp_path, huge_output)
            state_path = tmp_path / "state.json"
            state_path.write_text(json.dumps({"s1": "baseline"}))
            with patched_env(ULTRACONTEXT_CLI=str(fake_uc), ULTRACONTEXT_HERMES_STATE_FILE=str(state_path)):
                plugin = load_plugin()
                result = plugin.on_pre_llm_call(session_id="s1", user_message="continua")

            self.assertIsInstance(result, dict)
            self.assertLessEqual(len(result["context"]), 3500)
            self.assertIn("UltraContext activity signal", result["context"])
            injected_events = result["context"].split("Recent shared UC events (metadata only):\n", 1)[1]
            first_event_line = injected_events.splitlines()[0]
            self.assertRegex(first_event_line, r"^- event-\d+ ")


    def test_pre_llm_call_returns_none_for_trivial_greeting_without_calling_uc(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_uc = make_fake_uc(Path(tmp), '{"kind":"chatgpt.session.updated"}\n')
            with patched_env(ULTRACONTEXT_CLI=str(fake_uc)):
                plugin = load_plugin()
                self.assertIsNone(plugin.on_pre_llm_call(session_id="s1", user_message="oi"))
            self.assertFalse((Path(tmp) / "uc.args").exists())

    def test_pre_llm_call_returns_none_when_uc_has_no_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_uc = make_fake_uc(Path(tmp), "\n")
            with patched_env(ULTRACONTEXT_CLI=str(fake_uc)):
                plugin = load_plugin()
                self.assertIsNone(plugin.on_pre_llm_call(session_id="s1", user_message="continua"))

    def test_pre_llm_call_fails_open_when_uc_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_uc = make_fake_uc(Path(tmp), "boom\n", exit_code=2)
            with patched_env(ULTRACONTEXT_CLI=str(fake_uc)):
                plugin = load_plugin()
                self.assertIsNone(plugin.on_pre_llm_call(session_id="s1", user_message="oi"))

    def test_plugin_manifest_matches_hermes_loader_keys(self):
        manifest = MANIFEST_PATH.read_text()
        self.assertIn("name: ultracontext", manifest)
        self.assertIn("provides_hooks:", manifest)
        self.assertIn("  - pre_llm_call", manifest)
        self.assertNotIn("\nhooks:\n", f"\n{manifest}")

    def test_plugin_module_is_syntax_valid(self):
        subprocess.run([sys.executable, "-m", "py_compile", str(PLUGIN_PATH)], check=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
