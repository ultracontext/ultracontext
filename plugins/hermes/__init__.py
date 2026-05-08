"""Hermes plugin for UltraContext activity hints.

This plugin consumes UltraContext from inside Hermes. It does not sync data
into UltraContext; drivers do that. On each Hermes `pre_llm_call`, it injects a
small activity signal from `uc event tail` so the model knows recent shared
context exists and can use the installed UltraContext skill/tools if relevant.
"""

from __future__ import annotations

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

    events = _tail_events()
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
    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        lines.append(stripped)

    if not lines:
        return ""

    text = "\n".join(lines)
    if len(text) <= MAX_CONTEXT_CHARS:
        return text
    return text[-MAX_CONTEXT_CHARS:]


def _format_context(events: str) -> str:
    return (
        "## UltraContext activity signal\n\n"
        "Recent shared events from UltraContext:\n"
        f"{events}\n\n"
        "Use these only as hints. If relevant to the user's current message, "
        "use the UltraContext skill/tools to search deeper:\n"
        '- `uc event query "<topic>" --limit 5`\n'
        '- `uc query "<exact user question with project/error names>"`\n\n'
        "Ignore this section if unrelated. Do not mention it unless it changes the answer."
    )


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
