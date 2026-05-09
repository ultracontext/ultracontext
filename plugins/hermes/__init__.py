"""Hermes plugin for UltraContext activity hints.

This plugin consumes UltraContext from inside Hermes. It does not sync data
into UltraContext; drivers do that. On each Hermes `pre_llm_call`, it injects a
small activity signal from `uc event tail` so the model knows recent shared
context exists and can use the installed UltraContext skill/tools if relevant.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

DEFAULT_EVENT_LIMIT = 20
DEFAULT_TIMEOUT_SECONDS = 3
MAX_CONTEXT_CHARS = 3000
MAX_EVENT_LIMIT = 50


def register(ctx: Any) -> None:
    """Register the plugin with Hermes."""
    ctx.register_hook("pre_llm_call", on_pre_llm_call)


def on_pre_llm_call(**kwargs: Any) -> Optional[Dict[str, str]]:
    """Return an ephemeral UltraContext activity signal for the current turn.

    Hermes appends returned `context` to the user message. Fail open: if `uc`
    is missing, slow, or returns no events, inject nothing.
    """
    if _env_false("ULTRACONTEXT_HERMES_ENABLED"):
        return None

    if _is_trivial_user_message(kwargs.get("user_message")):
        return None

    events = _tail_events()
    if not events:
        return None

    session_id = str(kwargs.get("session_id") or "default")
    events = _events_since_last_turn(session_id, events)
    if not events:
        return None

    context = _format_context(events)
    if not context:
        return None
    return {"context": context}


def _tail_events() -> str:
    uc = _resolve_uc_cli()
    limit = _int_env("ULTRACONTEXT_HERMES_EVENT_LIMIT", DEFAULT_EVENT_LIMIT)
    limit = max(1, min(limit, MAX_EVENT_LIMIT))
    timeout = _int_env("ULTRACONTEXT_HERMES_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    timeout = max(1, min(timeout, 30))

    try:
        proc = subprocess.run(
            [uc, "event", "tail", "--limit", str(limit)],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired, OSError):
        return ""

    if proc.returncode != 0:
        return ""
    return _trim_events(proc.stdout or "")


def _resolve_uc_cli() -> str:
    configured = os.getenv("ULTRACONTEXT_CLI")
    if configured:
        return configured

    local_bin = Path.home() / ".local" / "bin" / "uc"
    if local_bin.exists():
        return str(local_bin)

    return "uc"


def _trim_events(raw: str) -> str:
    lines = []
    total_chars = 0
    for line in reversed(raw.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        next_total = total_chars + len(stripped) + (1 if lines else 0)
        if lines and next_total > MAX_CONTEXT_CHARS:
            break
        if not lines and len(stripped) > MAX_CONTEXT_CHARS:
            stripped = stripped[:MAX_CONTEXT_CHARS]
            next_total = len(stripped)
        lines.append(stripped)
        total_chars = next_total

    if not lines:
        return ""

    return "\n".join(reversed(lines))


def _events_since_last_turn(session_id: str, events: str) -> str:
    lines = [line.strip() for line in events.splitlines() if line.strip()]
    if not lines:
        return ""

    event_ids = [_event_cursor_id(line) for line in lines]
    current_cursor = event_ids[-1]
    state = _load_state()
    previous_cursor = state.get(session_id)
    state[session_id] = current_cursor
    _save_state(state)

    if not previous_cursor:
        return ""

    try:
        previous_index = event_ids.index(previous_cursor)
    except ValueError:
        return "\n".join(lines)

    return "\n".join(lines[previous_index + 1 :])


def _event_cursor_id(line: str) -> str:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return line
    if isinstance(event, dict):
        return str(event.get("event_id") or line)
    return line


def _state_path() -> Path:
    configured = os.getenv("ULTRACONTEXT_HERMES_STATE_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".hermes" / "plugins" / "ultracontext" / "state.json"


def _load_state() -> Dict[str, str]:
    path = _state_path()
    try:
        raw = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items() if isinstance(value, str)}


def _save_state(state: Dict[str, str]) -> None:
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, sort_keys=True))
    except OSError:
        pass


def _format_context(events: str) -> str:
    compact_events = _compact_events(events)
    if not compact_events:
        return ""
    return (
        "## UltraContext activity signal\n\n"
        "Recent shared UC events (metadata only):\n"
        f"{compact_events}\n\n"
        "If relevant, query deeper with `uc event query \"<topic>\" --limit 5`."
    )


def _compact_events(events: str) -> str:
    lines = []
    for raw_line in events.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lines.append(_compact_event_line(line))
    return "\n".join(line for line in lines if line)


def _compact_event_line(line: str) -> str:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return f"- {line}"
    if not isinstance(event, dict):
        return f"- {line}"

    kind = str(event.get("kind") or "event")
    subject = str(event.get("subject") or "-")
    labels = event.get("labels") if isinstance(event.get("labels"), dict) else {}
    counts = event.get("counts") if isinstance(event.get("counts"), dict) else {}
    title = labels.get("title") or labels.get("app") or ""
    payload_ref = event.get("payload_ref") or ""
    count_bits = []
    for key in ("changed_sessions", "synced", "failed", "message_count"):
        if key in counts:
            count_bits.append(f"{key}={counts[key]}")

    pieces = [f"- {kind}", f"subject={subject}"]
    if title:
        pieces.append(f"title={title}")
    if count_bits:
        pieces.append(",".join(count_bits))
    if payload_ref:
        pieces.append(f"payload_ref={payload_ref}")
    return " | ".join(pieces)


def _is_trivial_user_message(message: Any) -> bool:
    if not isinstance(message, str):
        return False
    text = message.strip().lower()
    return text in {"oi", "olá", "ola", "hello", "hi", "hey", "yo", "e aí", "e ai"}


def _int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_false(name: str) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return False
    return raw.strip().lower() in {"0", "false", "no", "off"}
