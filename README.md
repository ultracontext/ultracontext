# UltraContext - Same Context, Everywhere.

> One context layer for every AI agent on every machine.

UltraContext automatically captures everything Claude Code, Codex and OpenClaw do during sessions and syncs into a single workspace folder, then lets any agent search across all of it through a CLI. Written entirely in rust and open source, as it should be.

```sh
uc init user@vps --host-id macbook
uc sync start
uc search "what did we ship in the rewrite branch?"
```

## Why

Agents forget across sessions, machines, and tools. UltraContext makes their memory portable:

- **Unified workspace** — Claude on your laptop, Codex on your desktop, OpenClaw on a VPS, all in one tree.
- **Files are truth** — raw session files, no proprietary format, no migration risk.
- **Agentic search** — Claude reads the workspace and returns the relevant context. No index to rebuild.
- **Self-hosted by default** — your machine, your VPS, your data.

## How it works

```text
~/.claude   ─┐
~/.codex    ─┼──▶  ~/.ultracontext/workspace/sessions/<host>/<agent>/
~/.openclaw ─┘                       │
                                     ▼
                                 uc search  ──▶  Claude (or any agent)
```

- One-way sync, real-time, conflict-free.
- Workspace lives wherever you want — your laptop, your VPS, your homelab.
- Claude is the default search agent. Swap it for any CLI tool that takes a prompt.

## Install

```sh
cargo install ultracontext
ln -sf ~/.cargo/bin/ultracontext ~/.cargo/bin/uc
```

Requirements: [Mutagen](https://mutagen.io/) (`brew install mutagen-io/mutagen/mutagen`), SSH, and [Claude Code](https://docs.claude.com/en/docs/claude-code) for search.

Verify:

```sh
uc doctor
```

## Quickstart

**Remote workspace** (recommended — sync from many machines into one VPS):

```sh
uc init user@vps --host-id macbook
uc sync start
uc search "where did we leave off on the rewrite?"
```

**Local workspace** (single machine):

```sh
uc init local --host-id mini
uc sync start
uc search "latest codex session"
```

**Add another source**:

```sh
uc source add openclaw ~/.openclaw
```

Sync starts immediately.

## Commands

| Command | What it does |
|---|---|
| `uc init [local\|user@host]` | Configure workspace target and detect agent folders |
| `uc sync start` | Start syncing every enabled source |
| `uc sync status` | Show Mutagen session state |
| `uc sync stop` | Pause all sync sessions |
| `uc sync reset` | Recreate sessions after editing global settings or ignore rules |
| `uc source add <name> <path>` | Add and start a new source |
| `uc source list` | List configured sources and their state |
| `uc source enable <name>` / `disable <name>` | Toggle a single source |
| `uc source remove <name>` | Stop and remove a source |
| `uc search "<query>"` | Ask the search agent for relevant context |
| `uc doctor` | Verify dependencies, config, and remote access |

`uc` and `ultracontext` are the same binary.

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

[search]
command = "claude"
args    = "--dangerously-skip-permissions --effort medium --model sonnet"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

Config reloads on every command. Source changes apply immediately. Global setting and ignore changes apply on `uc sync reset`.

## Ignore rules

Every ignore lives in `~/.ultracontextignore`. Nothing is hardcoded. `uc init` and `uc sync start` seed the file with opinionated defaults you can comment out, edit, or extend:

```text
.git/
node_modules/   target/   dist/   build/   .next/   .cache/
logs/   *.log   *.log.*
Cache/   Cache_Data/   GPUCache/   Code Cache/   blob_storage/
*.sqlite-wal   *.sqlite-shm
.DS_Store
```

Run `uc sync reset` after editing the file.

Secrets and agent context (`.env`, `auth.json`, `credentials.json`) are **never** redacted. Files are the truth.

## Search

`uc search` runs your configured search command against the workspace with a context-engineer prompt. The agent returns relevant context to inject into another agent's prompt — not a final answer.

Customize the prompt:

```text
src/prompts/context-engineer.md
```

Customize the agent:

```toml
[search]
command = "codex"               # or any CLI that accepts a prompt
args    = "--model gpt-5"
```

## Status

UltraContext 2.0 is in alpha. The sync engine, source management, ignore rules, and remote/local search work end-to-end. The next milestones are sharper install/bootstrap, deeper ignore defaults, and `uc source status`.

## Development

```sh
cargo test                                       # unit + integration
cargo test --test e2e -- --ignored --nocapture   # real Mutagen E2E
```

Real E2E needs `UC_E2E_REMOTE=user@host`. Optional `UC_E2E_SEARCH=1` exercises remote Claude search. Copy `.envrc.example` to `.envrc` for local runs.

## License

Apache-2.0.
