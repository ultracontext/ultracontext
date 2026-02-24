<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">The Context Hub for AI agents.</h3>

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

<div align="center">

## All agents. All machines. One Hub.

</div>

<img src="https://ultracontext.ai/ultracontext-hub.gif" alt="How it works" />

## Introduction

Agents now do our work. Today, most of our knowledge and key decisions live inside context windows. But they are spread across many agents, computers, and teams.

Not anymore.

## UltraContext Features

- **Auto-ingest** — Captures contexts from your agents in realtime.
- **Realtime access** — Immediately see contexts created on any machine, by any agent, whenever you want.
- **Collaborate** — Share contexts across your team. See what everyone sees, instantly and without any friction.
- **Switch between agents** — Pick up where one agent left off with another.
- **Open source** — Own your data. Self-host when you need to.
- **Plug and play** — Install and run with a single line of code.
- **Fork & clone** — Continue contexts while preserving the full history.
- **Customizable** — Add your own agents and extend behavior with the context API ([Docs here](https://ultracontext.ai/docs/api-reference/introduction)).

## Install

Requires **Node >= 22**.

```bash
npm install -g ultracontext
```

That's it. The setup wizard runs automatically — walks you through API key, sync preferences, and launches the dashboard.

Already installed? Run `ultracontext config` to reconfigure.

## Quick Start

```bash
ultracontext              # start daemon + open dashboard
ultracontext config       # run setup wizard
ultracontext start        # start daemon only
ultracontext stop         # stop daemon
ultracontext status       # check if daemon is running
ultracontext tui          # open dashboard only
```

The default ultracontext command does everything: checks the daemon, starts it if needed, and opens the TUI dashboard.

## How it works

1. A daemon runs in the background, watching your agents.
2. Contexts are ingested in realtime with the Context API.
3. Your Context Hub gets updated.

We use a git-like context engineering API under the hood to interact with the agent's contexts. You can use it to add your own custom agents, tweak behavior and more. ([Docs here](https://ultracontext.ai/docs/))

When you open an existing session from the hub, it forks the context, so the original context is always preserved by default and automatically versioned so you can keep track of it later using metadata.

There is a local caching layer that prevents duplicate context creations and appends.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext&type=date&legend=top-left)

## Everything we built so far

- Daemon - Runs in the background, watching your agents.
- TUI - Terminal UI for the daemon.
- [Context API](https://ultracontext.ai/docs/) - Git-like context engineering API.
- [Context API SDKs](https://ultracontext.ai/docs/quickstart/nodejs) - Node and Python SDKs.

<div align="center">

# The Context API

</div>

The Context API is the simplest way to control what your agents see. Replace messages, compact/offload long context, replay decisions and roll back mistakes with a single API call. Versioned context out of the box. Full history. Zero complexity. You can use the API standalone to build your own agents or to tweak behavior of existing ones in ultracontext. ([Docs here](https://ultracontext.ai/docs/api-reference/introduction))

## Context API SDKs

| SDK | Install | Source |
|-----|---------|--------|
| JavaScript/TypeScript | `npm install ultracontext` | [apps/js-sdk](./apps/js-sdk) |
| Python | `pip install ultracontext` | [apps/python-sdk](./apps/python-sdk) |


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

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart/nodejs) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation

---
