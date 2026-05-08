# UltraContext Plugins

Plugins are host-runtime integrations that consume UltraContext inside another agent/runtime.

They are the opposite direction from drivers:

- **Driver / adapter**: external app or data source -> UltraContext events/artifacts.
- **Plugin**: UltraContext -> host runtime behavior.

Use a plugin when UltraContext should change how an agent behaves before or during a turn. Use a driver when an app should publish facts or artifacts into UltraContext.

## Current plugins

- `plugins/hermes/` — Hermes Agent `pre_llm_call` plugin. It injects a bounded activity signal from `uc event tail` before each model call.

## Repository naming

Plugin folders are named by host runtime:

```text
plugins/<host-runtime>/
```

Examples:

```text
plugins/hermes/
plugins/claude-code/
plugins/codex/
```

Do not repeat `ultracontext` in the folder name inside this repo. The repo already gives that context.

## Runtime behavior rule

A plugin should be small and fail-open:

1. Read only bounded UltraContext state by default.
2. Inject hints, not raw transcripts.
3. Let the model use the UltraContext skill/tools for deeper retrieval when needed.
4. Never block the host runtime if `uc` is missing, slow, or returns an error.
5. Keep app-specific ingestion out of plugins; put it in drivers.

## Install shape

The repo path and host install path do not have to be identical.

For example, the Hermes plugin lives in this repo at:

```text
plugins/hermes/
```

But its Hermes plugin key is `ultracontext`, from `plugin.yaml`:

```yaml
name: ultracontext
```

So Hermes enables it as:

```yaml
plugins:
  enabled:
    - ultracontext
```
