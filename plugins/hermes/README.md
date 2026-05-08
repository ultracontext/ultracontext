# Hermes plugin

Hermes runtime plugin for UltraContext.

It registers a `pre_llm_call` hook and injects a small activity signal from:

```bash
uc event tail --limit <n>
```

The injected text is only a hint. It tells the LLM recent shared events exist and points it to the UltraContext skill/tools for deeper retrieval:

```bash
uc event query "<topic>" --limit 5
uc query "<exact user question>"
```

## Boundary

- This is a **plugin**: UltraContext -> Hermes runtime.
- It is not a driver.
- It does not sync ChatGPT, Claude, or Hermes sessions into UltraContext.
- It does not read transcripts or payload refs automatically.
- It fails open: if `uc` is missing, slow, or returns no events, it injects nothing.

## Configuration

Environment variables:

- `ULTRACONTEXT_CLI`: path to `uc`; default resolution is `~/.local/bin/uc`, then `uc` from PATH.
- `ULTRACONTEXT_HERMES_EVENT_LIMIT`: event tail limit, default `20`, max `50`.
- `ULTRACONTEXT_HERMES_TIMEOUT_SECONDS`: command timeout, default `3`, max `30`.
- `ULTRACONTEXT_HERMES_ENABLED=false`: disable injection.

## Install into Hermes

Copy this folder to a Hermes plugin root, for example:

```text
~/.hermes/plugins/hermes/
```

Then enable it in Hermes config:

```yaml
plugins:
  enabled:
    - hermes
```

Restart Hermes or the gateway after enabling.
