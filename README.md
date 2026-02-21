<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/og-node.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">The context API for AI agents.</h3>

<p align="center">
  <a href="https://ultracontext.ai/docs">Documentation</a>
  ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a>
  ·
  <a href="https://ultracontext.ai/docs/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ultracontext">
    <img src="https://img.shields.io/npm/v/ultracontext" alt="npm version" />
  </a>
  <a href="https://pypi.org/project/ultracontext/">
    <img src="https://img.shields.io/pypi/v/ultracontext" alt="PyPI version" />
  </a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ultracontext/ultracontext" alt="license" />
  </a>
  <a href="https://github.com/ultracontext/ultracontext">
    <img src="https://img.shields.io/github/stars/ultracontext/ultracontext.svg?style=social&label=Star" alt="GitHub stars" />
  </a>
</p>

<div align="center">
  <a href="https://twitter.com/ultracontext">
    <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
  </a>
</div>

---

UltraContext is the simplest way to control what your agents see.

Replace messages, compact/offload context, replay decisions and roll back mistakes — with a single API call. Versioned context out of the box. Full history. Zero complexity.

## Why Context Matters

Context is the RAM of LLMs — everything they can see.

As context grows, model attention spreads thin — this is known as **context rot**. We should aim to provide the smallest set of high-signal tokens that get the job done.

Right now, we're reinventing the wheel for every car we build. Instead of tackling interesting problems, we catch ourselves spending most of our time gluing context together.

**It's time to simplify.**

## Why UltraContext

- **Simple API** — Five methods. That's it.
- **Automatic versioning** — Updates/deletes create versions. Nothing is lost.
- **Time-travel** — Jump to any point by version, index, or timestamp.
- **Schema-free** — Store any JSON. Own your data structure.
- **Framework-agnostic** — Works with any LLM framework.
- **Fast** — Globally distributed. Low latency.

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext&type=date&legend=top-left)

---

## Quick Start

### JavaScript/TypeScript

```bash
npm install ultracontext
```

```js
import { UltraContext } from 'ultracontext';

const uc = new UltraContext({ apiKey: 'uc_live_...' });

const ctx = await uc.create();
await uc.append(ctx.id, { role: 'user', content: 'Hello!' });

// use with any LLM framework
const response = await generateText({ model, messages: ctx.data });
```

### Python

```bash
pip install ultracontext
```

```python
from ultracontext import UltraContext

uc = UltraContext(api_key="uc_live_...")

ctx = uc.create()
uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

# use with any LLM framework
response = generate_text(model=model, messages=uc.get(ctx["id"])["data"])
```

Get an API key from the [UltraContext Dashboard](https://ultracontext.ai/dashboard).

---

## SDKs

| SDK | Install | Source |
|-----|---------|--------|
| JavaScript/TypeScript | `npm install ultracontext` | [apps/js-sdk](./apps/js-sdk) |
| Python | `pip install ultracontext` | [apps/python-sdk](./apps/python-sdk) |

---

## Monorepo Development

Workspace apps live in `apps/*` and shared internal modules live in `packages/*`.

```bash
pnpm install
pnpm ultracontext:db:up
pnpm ultracontext:migrate
pnpm ultracontext:api
pnpm ultracontext:key:local
pnpm --filter ultracontext-daemon run dev
pnpm --filter ultracontext-tui run dev
```

---

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart/nodejs) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation

---

<p align="center">
  <a href="https://ultracontext.ai">Website</a>
  ·
  <a href="https://ultracontext.ai/docs">Docs</a>
  ·
  <a href="https://github.com/ultracontext/ultracontext/issues">Issues</a>
</p>
