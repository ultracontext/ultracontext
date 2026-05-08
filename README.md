# UltraContext - Same Context, Everywhere.

> One context layer for every AI agent on every machine.

UltraContext automatically captures everything Claude Code, Codex and OpenClaw do during sessions and syncs into a single workspace folder, then lets any agent query across all of it through a CLI. The core CLI is Rust and open source, as it should be.

## Quickstart

```sh
curl -fsSL https://ultracontext.com/install.sh | sh
# or: npm install -g ultracontext

uc init
uc query "what did we ship in the rewrite?"
```

The install script starts `uc init` when it can use your terminal. With npm, run `uc init` after install.

Add more sources with `uc source add <name> <path>`.

The installer provides `ultracontext`, `uc`, and Mutagen when it is missing. SSH is needed for remote sync. Claude Code is the default query agent. Run `uc doctor` to verify.

## Why

Agents need horizontal intelligence, so they remain sharp and lean across sessions, machines, and tools by getting relevant context on demand.

- **Unified workspace** — Claude on your laptop, Codex on your desktop, OpenClaw on a VPS, all in one tree.
- **Files are truth** — raw session files, no proprietary format, no lock-in risk.
- **Agentic query** — Claude recursively reads the workspace and gets the relevant context on demand. No index to rebuild.
- **Self-hosted by default** — your machine, your VPS, your data.

## How it works

```text
~/.claude   ─┐
~/.codex    ─┼──▶  ~/.ultracontext/workspace/<host>/<source-folder>/
~/.openclaw ─┘                       │
                                     ▼
                                 uc query   ──▶  Claude (or any agent)
```

- One-way sync, real-time, conflict-free.
- Workspace lives wherever you want — your laptop, your VPS, your homelab.
- Claude is the default query agent. Swap it for any CLI tool that takes a prompt.

## Commands

Main commands:

| Command | What it does |
|---|---|
| `uc init [local\|user@host]` | Interactive onboarding: choose where UltraContext lives, choose agents, install skill, start sync |
| `uc status` | Show compact workspace and source sync overview |
| `uc query "<query>"` | Ask the query agent for relevant context |
| `uc doctor` | Verify dependencies, config, and remote access |
| `uc update` | Update using the active install manager |

Source commands:

| Command | What it does |
|---|---|
| `uc source add <name> <path> [--disabled]` | Add a source and start syncing it unless disabled |
| `uc source list` | List configured sources and their state |
| `uc source enable <name>` / `disable <name>` | Toggle one source |
| `uc source remove <name> [--yes]` | Confirm, terminate sync, delete the remote copy, and remove the source from config. Local files stay in place |

Sync commands:

| Command | What it does |
|---|---|
| `uc sync start` | Start syncing every enabled source |
| `uc sync list` | List configured sync sessions and their current state |
| `uc sync status` | Show Mutagen session state |
| `uc sync stop` | Pause every enabled source |
| `uc sync reset` | Recreate sessions after editing global settings or ignore rules |

Event commands:

| Command | What it does |
|---|---|
| `uc event emit --kind <kind> --source <source> --subject <id> [--privacy metadata_only] [--label key=value]` | Create a pending native UltraContext Event Envelope v1 and commit it to the configured server log |
| `uc event commit --from-stdin` | Server-side commit path: read one event JSON from stdin, set/overwrite `received_at`, dedupe, and append to the server log |
| `uc event tail [--limit <n>]` | Print recent committed events |
| `uc event query <text> [--limit <n>]` | Search committed events by text |
| `uc event flush` | Retry events still pending in the local outbox |
| `uc event status` | Show server, host id, pending outbox count, and sent count |

Native UC events use the versioned `uc.event.v1` envelope documented in `docs/primitives/event-envelope-v1.md`. Events are server-authoritative: `uc event emit` writes a pending envelope to the client outbox, then asks the configured server to run `uc event commit --from-stdin` when `uc` is installed remotely, with a Python server-side fallback for bare SSH hosts. The commit path sets/overwrites `received_at`, dedupes by `event_id`, and appends to `events/events.jsonl`. Clients keep a local durable outbox at `~/.ultracontext/events/outbox/` only for retry, then move committed events to `~/.ultracontext/events/sent/`. Events are small facts; large/details payloads belong in artifacts referenced by `payload_ref`. Do not put raw prompts, transcripts, secrets, cookies, API keys, tokens, headers, signed URLs, or huge payloads in event JSON.

Driver commands:

| Command | What it does |
|---|---|
| `uc driver list` | List installed external drivers from `~/.ultracontext/drivers/*/driver.toml` |
| `uc driver run <driver> <command>` | Run a named installed driver command |

Drivers/adapters are external integration code around UC primitives, not core runtime dependencies. The core repo ships the driver contract and CLI only. Product-specific or community drivers are installed separately under `~/.ultracontext/drivers/<name>/driver.toml`.

Plugins are the opposite direction: UC context consumed inside a host runtime. The first plugin lives at `plugins/hermes/` and registers a Hermes `pre_llm_call` hook that injects a bounded `uc event tail` activity signal so the model knows when to use the UltraContext skill for deeper lookup. See `docs/plugins/README.md` and `docs/plugins/hermes.md`.

Advanced:

| Command | What it does |
|---|---|
| `uc init local --no-sync` | Configure a local workspace without starting sync |
| `uc init user@vps --yes` | Non-interactive init for scripts |
| `uc init user@vps --host-id macbook --remote-root ~/.ultracontext --yes` | Fully explicit non-interactive init |

`uc` and `ultracontext` are the same binary.

## Install

Recommended:

```sh
curl -fsSL https://ultracontext.com/install.sh | sh
```

Alternative npm path:

```sh
npm install -g ultracontext
```

Both paths install the Rust binary and make `uc` available. Both also ensure Mutagen is available, because `uc sync` is a wrapper over Mutagen sync.

Re-running the install command is an update. `uc init` can be rerun to reconfigure the workspace and agents. `uc doctor` warns if multiple installs are on PATH.

## Workspace layout

```text
~/.ultracontext/
  config.toml
  workspace/
    <host-id>/
      .claude/
      .codex/
      .openclaw/
      <custom-source>/
```

Host comes first, then source folder. Built-in agent sources keep their native dot-folder names (`.claude`, `.codex`, `.openclaw`, `.hermes`) in the workspace; custom source names become folder names, so they are limited to letters, numbers, hyphens, and underscores.

## Config

`~/.ultracontext/config.toml`:

```toml
remote      = "user@vps"        # or "local"
remote_root = "~/.ultracontext"
host_id     = "macbook"

[query]
command = "claude"
args    = "-p {{prompt}} --dangerously-skip-permissions --effort medium --model sonnet"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

Ignore files live under `~/.ultracontext/ignores/` and use Mutagen's gitignore-style syntax. The global file is `~/.ultracontext/ignores/.ultracontextignore`; source-specific files live at `~/.ultracontext/ignores/<source>/.ultracontextignore`. `uc init` syncs Claude/Codex broadly with no source-specific default ignores; OpenClaw starts with conversations and complete workspace directories, excluding `node_modules`. Source changes apply immediately. Global settings and ignore edits apply on `uc sync reset`.

## Query

`uc query` runs your configured query command against the workspace with a context-engineer prompt. The agent returns relevant context on demand to inject into another agent's prompt — not a final answer.

Customize the prompt:

```text
~/.ultracontext/prompts/query.md
```

Edit it freely — `uc query` reads it on every invocation. Delete it and `uc query` will pass your query string straight to the agent with no template at all.

Customize the agent:

```toml
[query]
command = "codex"               # or any CLI that accepts a prompt
args    = "-p {{prompt}} --model gpt-5"
```

UltraContext replaces `{{prompt}}` in `args` with the rendered prompt. That
keeps the command shape configurable instead of hardcoding one prompt flag:

```toml
[query]
command = "pi"
args    = "--thinking high -p {{prompt}}"
```

## Development

```sh
cargo test                                       # unit + integration
npm run test:npm                                # npm installer mapping tests
sh -n install.sh                                # install script syntax
./install.sh --dev                              # local installer smoke test
cargo test --test e2e -- --ignored --nocapture   # real Mutagen E2E
```

Real E2E needs `UC_E2E_REMOTE=user@host`. Optional `UC_E2E_QUERY=1` exercises remote Claude query. Copy `.envrc.example` to `.envrc` for local runs.

## License

Apache-2.0.
