<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">Same context everywhere.</h3>

<p align="center">
  Start on Claude Code. Pick up on Codex. Open source, realtime infrastructure for the ones shipping at inference speed.
</p>

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

![ultracontext-gif](https://github.com/user-attachments/assets/be73afe5-161d-4fa3-8f4d-c4987fe63cb4)

## Install

Requires Node >= 22.

```bash
npm install -g ultracontext
```

## How it works

1. **A daemon watches your agents** — auto-captures context from Claude Code, Codex, and OpenClaw in realtime. Zero config.
2. **Contexts sync everywhere** — available across agents, machines, and teammates via the Context API.
3. **Agents query each other** — the MCP Server lets any agent read contexts from other agents directly.

## CLI

```bash
ultracontext          # start daemon + open dashboard
ultracontext config   # run setup wizard
ultracontext start    # start daemon only
ultracontext stop     # stop daemon
ultracontext tui      # open dashboard only
```

## SDK

| SDK | Install | Source |
|-----|---------|--------|
| JavaScript/TypeScript | `npm install ultracontext` | [apps/js-sdk](./apps/js-sdk) |
| Python | `pip install ultracontext` | [apps/python-sdk](./apps/python-sdk) |

```typescript
import { UltraContext } from 'ultracontext';

const uc = new UltraContext({ apiKey: 'uc_live_...' });

// create a context and append messages
const ctx = await uc.create();
await uc.append(ctx.id, { role: 'user', content: 'Hello!' });

// list contexts filtered by source
const { data } = await uc.get({ source: 'claude', limit: 5 });
```

```python
from ultracontext import UltraContext

uc = UltraContext(api_key="uc_live_...")

ctx = uc.create()
uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

results = uc.get(source="claude", limit=5)
```

## MCP Server

Let your agents query contexts from other agents. Add to your Claude Code config:

```json
{
  "mcpServers": {
    "ultracontext": {
      "command": "npx",
      "args": ["-y", "ultracontext-mcp-server"]
    }
  }
}
```

Or connect to a hosted API:

```json
{
  "mcpServers": {
    "ultracontext": {
      "type": "streamable-http",
      "url": "https://api.ultracontext.ai/mcp",
      "headers": {
        "Authorization": "Bearer uc_live_..."
      }
    }
  }
}
```

## Self-host

Run the Context API on your own infrastructure — Node.js or Cloudflare Workers.

See the [self-hosting guide](https://ultracontext.ai/docs/guides/self-hosting).

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart) — Get running in 2 minutes
- [SDK Reference](https://ultracontext.ai/docs/sdk) — JavaScript & Python
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint docs
- [MCP Server](https://ultracontext.ai/docs/fundamentals/mcp-server) — Setup & usage
- [Self-hosting](https://ultracontext.ai/docs/guides/self-hosting) — Deploy your own
