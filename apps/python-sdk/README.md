<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/og-python.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">The context API for AI agents.</h3>

<p align="center">
  <a href="https://ultracontext.ai/docs/quickstart/python">Quickstart</a>
  ·
  <a href="https://ultracontext.ai/docs">Documentation</a>
  ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a>
</p>

<p align="center">
  <a href="https://pypi.org/project/ultracontext/">
    <img src="https://img.shields.io/pypi/v/ultracontext" alt="PyPI version" />
  </a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ultracontext/ultracontext" alt="license" />
  </a>
</p>

---

UltraContext is the simplest way to control what your agents see.

Replace messages, compact/offload context, replay decisions and roll back mistakes — with a single API call. Versioned context out of the box. Full history. Zero complexity.

## Why UltraContext

- **Simple API** — Five methods. That's it.
- **Automatic versioning** — Updates/deletes create versions. Nothing is lost.
- **Time-travel** — Jump to any point by version, index, or timestamp.
- **Schema-free** — Store any JSON. Own your data structure.
- **Framework-agnostic** — Works with any LLM framework.
- **Fast** — Globally distributed. Low latency.

---

## Install

```bash
pip install ultracontext
```

## Quick Start

```python
from ultracontext import UltraContext

uc = UltraContext(api_key="uc_live_...")

ctx = uc.create()
uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

# use with any LLM framework
response = generate_text(model=model, messages=uc.get(ctx["id"])["data"])
```

### Async

```python
import asyncio
from ultracontext import AsyncUltraContext

async def main():
    uc = AsyncUltraContext(api_key="uc_live_...")
    ctx = await uc.create()
    await uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

asyncio.run(main())
```

Get an API key from the [UltraContext Dashboard](https://ultracontext.ai/dashboard).

---

## API

```python
# create - new context or fork
ctx = uc.create()
ctx = uc.create(from_="ctx_abc123")
ctx = uc.create(from_="ctx_abc123", version=2)
ctx = uc.create(from_="ctx_abc123", at=5)
ctx = uc.create(metadata={"user_id": "123"})

# get - retrieve context (or list all)
ctxs = uc.get()
ctxs = uc.get(limit=10)
data = uc.get("ctx_abc123")
data = uc.get("ctx_abc123", version=2)
data = uc.get("ctx_abc123", at=5)
data = uc.get("ctx_abc123", history=True)

# append - add messages (schema-free)
uc.append(ctx["id"], {"role": "user", "content": "Hi"})
uc.append(ctx["id"], [{"role": "user", "content": "Hi"}, {"foo": "bar"}])

# update - modify by id or index (auto-versions)
uc.update(ctx["id"], id="msg_xyz", content="Fixed!")
uc.update(ctx["id"], index=-1, content="Fix last message")
uc.update(ctx["id"], id="msg_xyz", content="Fixed!", metadata={"reason": "typo"})

# delete - remove by id or index (auto-versions)
uc.delete(ctx["id"], "msg_xyz")
uc.delete(ctx["id"], -1)
uc.delete(ctx["id"], ["msg_a", "msg_b", -1], metadata={"reason": "cleanup"})
```

---

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart/python) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation

---

## License

MIT

---

<p align="center">
  <a href="https://ultracontext.ai">Website</a>
  ·
  <a href="https://ultracontext.ai/docs">Docs</a>
  ·
  <a href="https://github.com/ultracontext/ultracontext/issues">Issues</a>
</p>
