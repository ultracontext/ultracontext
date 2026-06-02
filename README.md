<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">The Context SDK for AI agents.</h3>

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

<p align="center">
  <strong>All you need to manage what your agents see.</strong>
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

UltraContext lets you manage what your agents see: create, update, version, fork, retrieve, and share context windows across tools.

Use it directly through the Context API, connect agents through MCP, or let the daemon auto-capture sessions from Claude Code, Codex, and OpenClaw.

## Features

| `uc` CLI | Local-first context versioning from your terminal. Create, append, get, update, delete, list — backed by SQLite, no server required. |
| --- | --- |
| Sync | fs-first Mutagen orchestration. Mirror agent session files across machines. |
| MCP Server | Share context everywhere. Built into the API, or run standalone via stdio. |
| Context API | Git-like context engineering API. Store, version, and retrieve agent context with zero complexity. |

---

## How it works

1. **Init.** `uc init` sets up a local SQLite store under `~/.ultracontext`.

2. **Capture.** Create a context and append to it from your terminal, or sync agent session files across machines.

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
uc init                                  # set up the local SQLite store
id=$(uc create)                          # create a context → prints its id
uc append "$id" "remember: deploy uses Fly.io"   # append a message
uc get "$id"                             # read the context
uc list                                  # list all contexts
```

The CLI manages **many contexts explicitly** — there is no default context. Every
targeted verb takes a context id (or the `UC_CONTEXT` env var), so you always know
exactly what you're touching:

```bash
export UC_CONTEXT=$id              # set once, then drop the id from each verb
echo "another note" | uc append    # body via stdin ($UC_CONTEXT is the target)
uc get
```

The CLI is **local-first**: every command talks to a local SQLite database at
`~/.ultracontext/uc.db`. No server, no API key needed. Pass `--remote` (or run
`uc init` with a hosted backend) to talk to the Context API instead.

### Command tree

```bash
uc create [--from <id>]                 # create a context, or fork/clone from <id>
uc append <id> [text]                   # append a message (text | --message | stdin)
uc get <id>                             # read a context (--version / --at / --before / --history)
uc update <id> --content <c>            # update messages (--id <m> | --index <i>)
uc delete <id>                          # delete a context (--permanent) or messages (--ids)
uc list                                 # list ALL contexts (--source / --project_path / --limit)

uc sync init <target> # set up fs-first sync to local | user@host
uc sync source add    # add a synced source
uc sync start|stop    # start / pause sync for enabled sources
uc sync status|list   # show live sessions / configured sources

uc init               # initialize ultracontext for this machine
uc doctor             # diagnose the local environment
uc upgrade            # self-update the CLI
uc commands --json    # the full command tree, machine-readable (for agents)
```

Every targeted verb resolves its context from the explicit `<id>` arg, else
`$UC_CONTEXT`, else a clear error. **Fork/clone** is `uc create --from <id>`
(optionally `--version` / `--at` / `--before`) — it mirrors the SDK's `create({ from })`.
`--meta key=val` (repeatable) attaches metadata: the **context** on `create`, the
**message** on `append`, the **version** on `update`/`delete`, an **audit** record on
`delete --permanent`.

Every command is pipe-aware: pass `--json` (or pipe stdout) to get machine-readable
output. Data goes to stdout; status and errors go to stderr. Run `uc commands --json`
for the authoritative, always-current tree.

## SDK

Building an agent? The SDK is how you manage its context window in code — create, version, fork, and retrieve context windows, with any LLM framework.

- **`create` · `append` · `get` · `update` · `delete`** (+ `deleteMany`) — that's the whole surface.
- **Versioned by default** — every `update`/`delete` is a new version; jump back with `version` / `at` / `before`.
- **Fork** — `create({ from })` branches a context, optionally from a past point.
- **Metadata** — tag the context, a message, or a version.
- **Framework-agnostic** — hand the messages to any model. No lock-in.

The CLI mirrors the SDK one-to-one (`uc create` / `uc append` / `uc get` / …).

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
const { data } = await uc.get(ctx.id);

// use with any LLM framework
const response = await generateText({ model, messages: data });
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

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext&type=date&legend=top-left)

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation
