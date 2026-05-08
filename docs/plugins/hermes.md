# Hermes Plugin

## Purpose

The Hermes plugin makes Hermes aware of recent UltraContext activity before each model call.

It is a **consumer plugin**, not an ingestion driver:

```text
UltraContext events/artifacts -> Hermes pre_llm_call -> LLM activity signal
```

It does not sync ChatGPT, Claude, Hermes, browser, or app data into UltraContext. That work belongs to drivers.

## Status

Experimental v0. It is intentionally small:

- hook: `pre_llm_call`
- source command: `uc event tail --limit <n>`
- output: bounded activity signal
- failure mode: fail-open, inject nothing

## Why `pre_llm_call`

`pre_llm_call` runs before every Hermes model call and can return:

```python
{"context": "..."}
```

Hermes appends that context to the current turn. That is the right moment to say “shared context changed elsewhere”.

Do not use `agent:start` / `on_session_start` for this v0. Those are lifecycle/init hooks, not per-turn context injection hooks.

## Behavior

On each turn, the plugin:

1. Resolves `uc`:
   - `ULTRACONTEXT_CLI` if set;
   - `~/.local/bin/uc` if it exists;
   - otherwise `uc` from PATH.
2. Runs:

   ```bash
   uc event tail --limit <n>
   ```

3. Trims blank lines and bounds injected text.
4. Returns a short context block telling the LLM:
   - recent shared events exist;
   - treat them as hints;
   - if relevant, use the UltraContext skill/tools:

     ```bash
     uc event query "<topic>" --limit 5
     uc query "<exact user question>"
     ```

It does **not** run `uc query` automatically. That is deliberate. The LLM should decide if deeper lookup is relevant to the current user message.

## Privacy rules

The plugin should not automatically read:

- raw transcripts;
- payload refs;
- cookies;
- tokens;
- headers;
- API keys;
- signed URLs;
- huge artifacts.

Events should stay small. Large data belongs in artifacts referenced by event `payload_ref`, and the model should fetch those only when relevant.

## Configuration

Environment variables:

- `ULTRACONTEXT_CLI`: explicit path to `uc`.
- `ULTRACONTEXT_HERMES_EVENT_LIMIT`: event tail limit. Default: `20`. Max: `50`.
- `ULTRACONTEXT_HERMES_TIMEOUT_SECONDS`: command timeout. Default: `3`. Max: `30`.
- `ULTRACONTEXT_HERMES_ENABLED=false`: disable injection.

## Install into Hermes

Hermes discovers user plugins under:

```text
~/.hermes/plugins/<plugin-dir>/
```

Recommended install shape:

```bash
mkdir -p ~/.hermes/plugins/ultracontext
cp -R plugins/hermes/* ~/.hermes/plugins/ultracontext/
```

Enable by plugin key/name, not by the repo folder name:

```yaml
plugins:
  enabled:
    - ultracontext
```

Why: the repo folder is `plugins/hermes/` because the host runtime is Hermes. The Hermes plugin manifest says `name: ultracontext`, and Hermes uses that name/key for `plugins.enabled` in the flat user-plugin layout.

Restart Hermes after enabling:

```bash
hermes gateway restart
```

For CLI sessions, start a new `hermes` process.

## Expected injected shape

Example:

```markdown
## UltraContext activity signal

Recent shared events from UltraContext:
<uc event tail output>

Use these only as hints. If relevant to the user's current message, use the UltraContext skill/tools to search deeper:
- `uc event query "<topic>" --limit 5`
- `uc query "<exact user question with project/error names>"`

Ignore this section if unrelated. Do not mention it unless it changes the answer.
```

## Failure behavior

Return no context if:

- `uc` is missing;
- `uc event tail` returns non-zero;
- the command times out;
- there are no events.

The plugin must not block or break Hermes.

## Tests

From the UltraContext repo root:

```bash
python3 plugins/hermes/tests/test_plugin.py
```

The tests cover:

- hook registration;
- event-tail command shape;
- no automatic deep query;
- bounded context size;
- empty output;
- fail-open behavior.
