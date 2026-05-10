"""Hermes plugin for UltraContext activity hints.

This plugin consumes UltraContext from inside Hermes. It does not sync data
into UltraContext; drivers do that. On each Hermes `pre_llm_call`, it injects a
small activity signal from `uc event tail` so the model knows recent shared
context exists and can use the installed UltraContext skill/tools if relevant.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import unquote, urlparse

DEFAULT_EVENT_LIMIT = 20
DEFAULT_TIMEOUT_SECONDS = 3
MAX_CONTEXT_CHARS = 3000
MAX_EVENT_LIMIT = 50
MAX_PAYLOAD_READ_CHARS = 4096
MAX_GIST_CHARS = 260
DEFAULT_PAYLOAD_EXCERPT_CHARS = 1800
MAX_PAYLOAD_EXCERPT_CHARS = 6000


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

    context = _format_context(events, kwargs.get("user_message"))
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


def _format_context(events: str, user_message: Any = None) -> str:
    compact_events = _compact_events(events, user_message)
    if not compact_events:
        return ""
    return "## UltraContext activity signal\n\n" f"{compact_events}"


def _compact_events(events: str, user_message: Any = None) -> str:
    parsed_events = []
    fallback_lines = []
    for raw_line in events.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        event = _parse_event(line)
        if event is None:
            fallback_lines.append(_compact_event_line(line))
            continue
        parsed_events.append(event)

    lifecycle_changed_event_ids = _lifecycle_changed_event_ids(parsed_events)
    session_lines = []
    for event in parsed_events:
        force_include = _session_update_matches_lifecycle_change(event, lifecycle_changed_event_ids)
        session_line = _compact_session_event(event, user_message, force_include=force_include)
        if session_line:
            session_lines.append(session_line)

    if session_lines:
        return "Recent relevant session updates:\n" + "\n".join(session_lines)

    non_session_lines = []
    for event in parsed_events:
        if _is_session_updated_event(event) and _session_event_has_readable_payload(event):
            continue
        non_session_lines.append(_compact_event_dict(event))

    all_lines = fallback_lines + [line for line in non_session_lines if line]
    if not all_lines:
        return ""
    return "Recent shared UC events (metadata only):\n" + "\n".join(all_lines)


def _compact_event_line(line: str) -> str:
    event = _parse_event(line)
    if event is None:
        return f"- {line}"
    return _compact_event_dict(event)


def _parse_event(line: str) -> Optional[Dict[str, Any]]:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(event, dict):
        return None
    return event


def _compact_event_dict(event: Dict[str, Any]) -> str:
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


def _is_session_updated_event(event: Dict[str, Any]) -> bool:
    return str(event.get("kind") or "").endswith(".session.updated")


def _lifecycle_changed_event_ids(events: list[Dict[str, Any]]) -> set[str]:
    ids = set()
    for event in events:
        kind = str(event.get("kind") or "")
        if not kind.endswith((".app.closed", ".app.opened")):
            continue
        counts = event.get("counts") if isinstance(event.get("counts"), dict) else {}
        try:
            changed_sessions = int(counts.get("changed_sessions") or 0)
        except (TypeError, ValueError):
            changed_sessions = 0
        if changed_sessions <= 0:
            continue
        event_id = str(event.get("event_id") or "")
        if event_id:
            ids.add(event_id)
    return ids


def _session_update_matches_lifecycle_change(event: Dict[str, Any], lifecycle_event_ids: set[str]) -> bool:
    if not lifecycle_event_ids or not _is_session_updated_event(event):
        return False
    parent_event_id = str(event.get("parent_event_id") or "")
    trace_id = str(event.get("trace_id") or "")
    return parent_event_id in lifecycle_event_ids or trace_id in lifecycle_event_ids


def _session_event_has_readable_payload(event: Dict[str, Any]) -> bool:
    payload_ref = str(event.get("payload_ref") or "")
    return bool(payload_ref and _read_payload_ref(payload_ref))


def _compact_session_event(event: Dict[str, Any], user_message: Any, force_include: bool = False) -> str:
    if not _is_session_updated_event(event):
        return ""

    payload_ref = str(event.get("payload_ref") or "")
    if not payload_ref:
        return ""

    payload_text = _read_payload_ref(payload_ref)
    if not payload_text:
        return ""

    labels = event.get("labels") if isinstance(event.get("labels"), dict) else {}
    title = str(labels.get("title") or _extract_markdown_title(payload_text) or "session")
    gist = _session_gist(payload_text, user_message, title)
    if not gist:
        return ""

    relevance_text = f"{title}\n{gist}\n{event.get('subject') or ''}\n{event.get('kind') or ''}"
    if not force_include and not _is_relevant_session(user_message, relevance_text):
        return ""

    source = _event_source_label(event)
    parts = [f"- New {source} session since last turn", f"title={_clean_inline(title)}", f"gist={_clean_inline(gist)}"]
    parts.append(f"payload_ref={payload_ref}")
    if _env_true("ULTRACONTEXT_HERMES_INCLUDE_PAYLOAD"):
        excerpt = _session_excerpt(payload_text)
        if excerpt:
            parts.append("excerpt=" + excerpt)
    return " | ".join(parts)


def _event_source_label(event: Dict[str, Any]) -> str:
    kind = str(event.get("kind") or "")
    labels = event.get("labels") if isinstance(event.get("labels"), dict) else {}
    app = str(labels.get("app") or "")
    source = f"{kind} {app}".lower()
    if "chatgpt" in source:
        return "ChatGPT"
    if "claude" in source:
        return "Claude"
    return "UC"


def _read_payload_ref(payload_ref: str) -> str:
    try:
        parsed = urlparse(payload_ref)
        if parsed.scheme != "file":
            return ""
        path = Path(unquote(parsed.path)).expanduser()
        if not path.exists() or not path.is_file():
            return ""
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return handle.read(MAX_PAYLOAD_READ_CHARS)
    except OSError:
        return ""


def _extract_markdown_title(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return ""


def _session_gist(text: str, user_message: Any, title: str) -> str:
    transcript_marker = re.search(r"(?im)^##\s+transcript\s*$", text)
    if transcript_marker:
        text = text[transcript_marker.end() :]

    candidates = []
    for line in text.splitlines():
        cleaned = _clean_payload_line(line)
        if not cleaned or cleaned == title:
            continue
        candidates.append(cleaned)

    if not candidates:
        return ""

    user_tokens = _tokens(str(user_message or ""))
    best = candidates[0]
    best_score = -1
    for candidate in candidates[:40]:
        score = len(user_tokens & _tokens(candidate))
        if any(marker in candidate.lower() for marker in ("deveria", "should", "porque", "fix", "corrigir", "plugin")):
            score += 3
        if score > best_score:
            best = candidate
            best_score = score

    if len(best) > MAX_GIST_CHARS:
        best = best[: MAX_GIST_CHARS - 1].rstrip() + "…"
    return best


def _session_excerpt(text: str) -> str:
    max_chars = _int_env("ULTRACONTEXT_HERMES_PAYLOAD_CHARS", DEFAULT_PAYLOAD_EXCERPT_CHARS)
    max_chars = max(1, min(max_chars, MAX_PAYLOAD_EXCERPT_CHARS))

    transcript_marker = re.search(r"(?im)^##\s+transcript\s*$", text)
    if transcript_marker:
        text = text[transcript_marker.end() :]

    lines = []
    total_chars = 0
    for line in text.splitlines():
        cleaned = _clean_payload_line(line)
        if not cleaned:
            continue
        next_total = total_chars + len(cleaned) + (1 if lines else 0)
        if next_total > max_chars:
            remaining = max_chars - total_chars - (1 if lines else 0)
            if remaining > 20:
                lines.append(cleaned[: remaining - 1].rstrip() + "…")
            break
        lines.append(cleaned)
        total_chars = next_total

    return "\n".join(lines)


def _clean_payload_line(line: str) -> str:
    stripped = line.strip()
    if not stripped or stripped == "---" or stripped.startswith("<!--"):
        return ""
    lowered = stripped.lower()
    if lowered.startswith((
        "schema:", "agent:", "session_id:", "conversation_id:", "title:", "started_at:", "ended_at:",
        "model:", "record_count:", "roles:", "content_types:", "current_node:", "branch_count:",
        "branch_point_count:", "current_path_length:", "leaf_nodes:", "source_path:", "raw_json_path:",
        "source_sha256:", "delta_sha256:", "generated_at:", "markdown_sha256:", "## metadata",
        "## transcript", "- session_id:", "- started_at:", "- ended_at:", "- model:", "- record_count:",
        "- current_node:", "- branch_count:", "- branch_point_count:", "- current_path_length:", "- roles:",
        "- leaf_nodes:",
    )):
        return ""
    if re.match(r"^#{1,6}\s+\d+\.\s+(user|assistant|system)\b", stripped, flags=re.IGNORECASE):
        return ""
    if stripped.startswith("#") and " session " in f" {lowered} ":
        return ""
    stripped = stripped.lstrip("# ").strip()
    stripped = re.sub(r"^(user|assistant|system|human|ai)\s*:\s*", "", stripped, flags=re.IGNORECASE)
    stripped = _redact_inline(stripped)
    return _clean_inline(stripped)


def _clean_inline(text: str) -> str:
    return " ".join(str(text).split())


def _redact_inline(text: str) -> str:
    text = re.sub(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*\S+", r"\1=[REDACTED]", text)
    text = re.sub(r"(?i)bearer\s+[a-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    return text


def _is_relevant_session(user_message: Any, session_text: str) -> bool:
    if not isinstance(user_message, str):
        return False
    user_tokens = _tokens(user_message)
    session_tokens = _tokens(session_text)
    if user_tokens & session_tokens:
        return True

    lowered = user_message.lower()
    generic_session_request = any(
        marker in lowered
        for marker in ("gpt", "chatgpt", "claude", "sessao", "sessão", "session", "o que fiz", "o que rolou")
    )
    if generic_session_request and any(source in session_text.lower() for source in ("chatgpt", "claude")):
        return True
    return False


def _tokens(text: str) -> set[str]:
    stopwords = {
        "a", "ai", "as", "ao", "aos", "antes", "com", "como", "da", "das", "de", "do", "dos",
        "e", "em", "eu", "na", "nas", "no", "nos", "o", "os", "ou", "para", "por", "pq",
        "que", "se", "um", "uma", "the", "to", "and", "or", "of", "in", "on", "is", "it",
    }
    return {token for token in re.findall(r"[\wÀ-ÿ]+", text.lower()) if len(token) > 2 and token not in stopwords}



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


def _env_true(name: str) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_false(name: str) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return False
    return raw.strip().lower() in {"0", "false", "no", "off"}
