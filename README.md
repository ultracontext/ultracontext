# UltraContext - Same Context, Everywhere.

> One context layer for every AI agent on every machine.

UltraContext automatically captures everything Claude Code, Codex and OpenClaw do during sessions and syncs into a single workspace folder, then lets any agent query across all of it through a CLI. The core CLI is Rust and open source, as it should be.

## Quickstart

```sh
curl -fsSL https://ultracontext.com/install.sh | sh
# or: npm install -g ultracontext

uc setup
uc query "what did we ship in the rewrite?"
```

The install script starts `uc setup` when it can use your terminal. With npm, run `uc setup` after install.

Add more sources with `uc source add <name> <path>`.

The installer provides `ultracontext`, `uc`, and Mutagen when it is missing. SSH is needed for remote sync. Claude Code is the default query agent. Run `uc doctor` to verify.

## Why

Agents need horizontal intelligence, so they remain sharp and lean across sessions, machines, and tools by getting relevant context on demand.

- **Unified workspace** — Claude on your laptop, Codex on your desktop, OpenClaw on a VPS, all in one tree.
- **Files are truth** — raw session files, no proprietary format, no migration risk.
- **Agentic query** — Claude recursively reads the workspace and gets the relevant context on demand. No index to rebuild.
- **Self-hosted by default** — your machine, your VPS, your data.

## How it works

```text
~/.claude   ─┐
~/.codex    ─┼──▶  ~/.ultracontext/workspace/sessions/<host>/<agent>/
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
| `uc setup [local\|user@host]` | Interactive onboarding: choose where UltraContext lives, choose agents, install skill, start sync |
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
| `uc source remove <name>` | Stop and remove one source |

Sync commands:

| Command | What it does |
|---|---|
| `uc sync start` | Start syncing every enabled source |
| `uc sync status` | Show Mutagen session state |
| `uc sync stop` | Pause all sync sessions |
| `uc sync reset` | Recreate sessions after editing global settings or ignore rules |

Advanced:

| Command | What it does |
|---|---|
| `uc setup local --no-sync` | Configure a local workspace without starting sync |
| `uc setup user@vps --yes` | Non-interactive setup for scripts |
| `uc setup user@vps --host-id macbook --remote-root ~/.ultracontext --yes` | Fully explicit non-interactive setup |

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

Re-running the install command is an update. `uc setup` can be rerun to reconfigure the workspace and agents. `uc doctor` warns if multiple installs are on PATH.

## Workspace layout

```text
~/.ultracontext/
  config.toml
  workspace/
    sessions/
      <host-id>/
        claude/
        codex/
        <custom-source>/
```

Host comes first, then agent. Source names become folder names, so they are limited to letters, numbers, hyphens, and underscores.

## Config

`~/.ultracontext/config.toml`:

```toml
remote      = "user@vps"        # or "local"
remote_root = "~/.ultracontext"
host_id     = "macbook"

[query]
command = "claude"
args    = "--dangerously-skip-permissions --effort medium --model sonnet"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

`~/.ultracontext/.ultracontextignore` works like `.gitignore`, seeded on `uc setup`. Source changes apply immediately. Global settings and ignore edits apply on `uc sync reset`.

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
args    = "--model gpt-5"
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
