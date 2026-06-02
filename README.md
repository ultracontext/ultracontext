<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">Same context. Everywhere.</h3>

<p align="center">
  Start on Claude Code. Continue on Codex.<br/>
  Open source, realtime and invisible context infrastructure for the ones shipping at inference speed.
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

What Claude Code knows, Codex doesn't. What your teammate is shipping right now? Your agent has no idea.

UltraContext captures every agent's context in realtime and makes it available to all of them. It's like having a personal context engineer everywhere. Continue a session in a different agent, or just ask what's happeming.

For example:

- *"Codex, grab the last plan Claude Code made and implement it."*
- *"What's the team building today?"*
- *"What is Alex working on in Codex right now?"*

Open source. Framework-agnostic. Customizable via the git-like Context API.

## Features

| `uc` CLI | Local-first context versioning from your terminal. Add, get, update, list — backed by SQLite, no server required. |
| --- | --- |
| Sync | fs-first Mutagen orchestration. Mirror agent session files across machines. |
| MCP Server | Share context everywhere. Built into the API, or run standalone via stdio. |
| Context API | Git-like context engineering API. Store, version, and retrieve agent context with zero complexity. |

---

## How it works

1. **Init.** `uc init` sets up a local SQLite store under `~/.ultracontext`.

2. **Capture.** Add context from your terminal, or sync agent session files across machines.

3. **Add the MCP server.** Any agent gets full awareness of every other agent.

4. **That's it.** Ask questions, continue sessions, fork — your context is everywhere.

## Install

Requires Node >= 22. One install gives you both the `uc` binary and the SDK.

```bash
npm install -g ultracontext   # the `uc` CLI, globally
npm install ultracontext      # the SDK + CLI, in a project
```

## Quick Start

```bash
uc init               # set up the local SQLite store
uc add "remember: deploy uses Fly.io"   # capture context for this project
uc list               # list contexts in the current project
uc get                # read the current project's context
```

The CLI is **local-first**: every command talks to a local SQLite database at
`~/.ultracontext/uc.db`, scoped per project directory. No server, no API key needed.
Pass `--remote` (or run `uc init` with a hosted backend) to talk to the Context API instead.

### Command tree

```bash
uc add [text]         # append a message to a context (quick-capture)
uc get                # read a context (--version / --at / --before / --history)
uc update             # update messages in a context
uc delete [id]        # delete a context (--permanent) or messages (--ids)
uc list               # list contexts (--source / --project_path / --limit)

uc sync init <target> # set up fs-first sync to local | user@host
uc sync source add    # add a synced source
uc sync start|stop    # start / pause sync for enabled sources
uc sync status|list   # show live sessions / configured sources

uc init               # initialize ultracontext for this machine
uc doctor             # diagnose the local environment
uc upgrade            # self-update the CLI
uc commands --json    # the full command tree, machine-readable (for agents)
```

Every command is pipe-aware: pass `--json` (or pipe stdout) to get machine-readable
output. Data goes to stdout; status and errors go to stderr. Run `uc commands --json`
for the authoritative, always-current tree.

## Context API

For builders who want to go deeper. Git-like primitives for context engineering.

- **Five methods** — Create, get, append, update, delete. That's it.
- **Automatic versioning** — Every change creates a new version. Full history out of the box.
- **Time-travel** — Jump to any point in your context history.
- **Framework-agnostic** — Works with any LLM framework. No vendor lock-in.

Use the API standalone to build your own agents, or extend existing ones in UltraContext.

| SDK                   | Install                    | Source                               |
| --------------------- | -------------------------- | ------------------------------------ |
| JavaScript/TypeScript | `npm install ultracontext` | [apps/cli](./apps/cli) (re-exports `@ultracontext/js`) |
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

## Monorepo

A pnpm monorepo. `npm i ultracontext` installs one package (`apps/cli`, published as
`ultracontext`) that bundles the CLI binary **and** re-exports the SDK.

```
packages/
  core      — @ultracontext/core: IO-free context engine + StorageAdapter port
  storage   — @ultracontext/storage: Drizzle / Supabase / SQLite adapters
  parsers   — @ultracontext/parsers: agent session parsers
  sync      — @ultracontext/sync: fs-first Mutagen orchestration

apps/
  cli         — the `uc` binary, published as `ultracontext` (CLI + SDK in one install)
  js-sdk      — @ultracontext/js: the TypeScript SDK source (private; re-exported by the CLI)
  api         — Hono REST API (the hosted Context API)
  mcp-server  — stdio + HTTP MCP server
  python-sdk  — the Python SDK (PyPI)
  postgres    — local Postgres + schema for self-hosting
  docs        — Mintlify documentation (this site)
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext-node&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext-node&type=date&legend=top-left)

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation
