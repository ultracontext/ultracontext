<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">Context infrastructure for AI agents.</h3>

<p align="center">
  <a href="https://ultracontext.ai/docs">Documentation</a> ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a> ·
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
  <a href="https://ultracontext.ai">
    <img src="https://img.shields.io/badge/Visit-ultracontext.ai-4B6EF5" alt="Visit ultracontext.ai" />
  </a>
</p>

<div align="center">
  <a href="https://twitter.com/ultracontext">
    <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
  </a>
  <a href="https://discord.com/invite/4HjcS6KwhW">
    <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
  </a>
</div>

---

<h2 align="center">All agents. One context.</h2>

Auto-capture and share your agents' context everywhere. Realtime. Open source.

![ultracontext-gif](https://github.com/user-attachments/assets/be73afe5-161d-4fa3-8f4d-c4987fe63cb4)

## Why Context Matters

Context is the RAM of LLMs — everything they can see.

As context grows, model attention spreads thin — this is why they hallucinate. We should aim to provide the smallest set of high-signal tokens that get the job done.

Right now, we're reinventing the wheel for every car we build. Instead of solving bigger problems with AI, we currently spend most of our time gluing context together.

**It's time to simplify.**

## Why UltraContext

**Context is all you need.**

The right primitive is context. It's the only thing models actually consume. It's all they see. It's all that matters. Build on that and every decision compounds correctly.

It turns out that there is no standard for context engineering. So we decided to make it. Our goal: **make shipping agents insanely simple by providing the best context infrastructure in the world.**

Time to ship.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext-node&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext-node&type=date&legend=top-left)

## Install

Requires Node >= 22.

```bash
npm install -g ultracontext
```

## The Hub

**All agents. One context.**

- **Auto-capture** — Ingests your agents' context in realtime. Zero config.
- **Switch between agents** — Pick up where one agent left off with another.
- **Collaborate** — Share contexts across your team. See what everyone sees. Realtime.
- **Fork & clone** — Continue contexts while preserving the full history.
- **Own your data** — Open source. Your contexts. Your rules.

### How it works

1. A daemon runs in the background, watching your agents.
2. Contexts are ingested in realtime.
3. Your dashboard gets updated.

### Quick Start

```bash
ultracontext          # start daemon + open dashboard
ultracontext config   # run setup wizard
ultracontext start    # start daemon only
ultracontext stop     # stop daemon
ultracontext status   # check if daemon is running
ultracontext tui      # open dashboard only
```

The default `ultracontext` command does everything: checks the daemon, starts it if needed, and opens the dashboard.

When you open an existing session, it forks the context — the original is always preserved and automatically versioned. A local caching layer prevents duplicate context creations and appends.

Add your own agents and extend behavior with the Context API. ([Docs here](https://ultracontext.ai/docs/))

## The API

**Context engineering built like Git.**

- **Five methods** — Create, get, append, update, delete. That's it.
- **Automatic versioning** — Every change creates a new version. Full history out of the box.
- **Time-travel** — Jump to any point in your context history.
- **Framework-agnostic** — Works with any LLM framework. No vendor lock-in.

The simplest way to control what your agents see. Replace messages, compact long context, replay decisions and roll back mistakes — all with a single API call. Versioned context out of the box. Full history. Zero complexity.

Use the API standalone to build your own agents, or to extend existing ones in UltraContext.


| SDK                   | Install                    | Source                               |
| --------------------- | -------------------------- | ------------------------------------ |
| JavaScript/TypeScript | `npm install ultracontext` | [apps/js-sdk](./apps/js-sdk)         |
| Python                | `pip install ultracontext` | [apps/python-sdk](./apps/python-sdk) |


### JavaScript/TypeScript

```bash
npm install ultracontext
```

```typescript
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

<p align="center">📚 Context API Guides</p>
<p align="center">
  <a href="https://ultracontext.ai/docs/guides/store-retrieve-contexts">Store & Retrieve</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/edit-contexts">Edit Contexts</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/fork-clone-contexts">Fork & Clone</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/view-context-history">View History</a>
</p>


## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart/nodejs) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation

## Star History

[Star History Chart](https://www.star-history.com/#ultracontext/ultracontext&type=date&legend=top-left)