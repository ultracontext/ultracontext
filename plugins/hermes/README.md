# Hermes plugin

Hermes runtime plugin for UltraContext.

It registers a `pre_llm_call` hook and injects a small activity signal from:

```bash
uc event tail --limit <n>
```

The injected text is only a hint. It contains the bounded event tail summary already selected by the plugin.

## Boundary

- This is a **plugin**: UltraContext -> Hermes runtime.
- It is not a driver.
- It does not sync ChatGPT, Claude, or Hermes sessions into UltraContext.
- By default, it injects compact metadata plus a short gist for relevant session updates.
- When an app lifecycle event reports `changed_sessions>0`, the matching `*.session.updated` child event wins over lifecycle metadata even for generic follow-ups like greetings.
- If `ULTRACONTEXT_HERMES_INCLUDE_PAYLOAD=true`, it can also read local `file://` payload refs and inject a bounded sanitized excerpt.
- It fails open: if `uc` is missing, slow, or returns no events, it injects nothing.

Full docs: `docs/plugins/hermes.md`.

## Configuration

Environment variables:

- `ULTRACONTEXT_CLI`: path to `uc`; default resolution is `~/.local/bin/uc`, then `uc` from PATH.
- `ULTRACONTEXT_HERMES_EVENT_LIMIT`: event tail limit, default `20`, max `50`.
- `ULTRACONTEXT_HERMES_TIMEOUT_SECONDS`: command timeout, default `3`, max `30`.
- `ULTRACONTEXT_HERMES_ENABLED=false`: disable injection.
- `ULTRACONTEXT_HERMES_INCLUDE_PAYLOAD=true`: include a bounded sanitized excerpt from relevant local `file://` session payloads.
- `ULTRACONTEXT_HERMES_PAYLOAD_CHARS`: payload excerpt limit, default `1800`, max `6000`.

## Install into Hermes

Hermes user plugins live under `~/.hermes/plugins/<plugin-dir>/`.

Recommended install shape:

```bash
mkdir -p ~/.hermes/plugins/ultracontext
cp -R plugins/hermes/* ~/.hermes/plugins/ultracontext/
```

Then enable the plugin by manifest name/key:

```yaml
plugins:
  enabled:
    - ultracontext
```

Restart Hermes or the gateway after enabling.
