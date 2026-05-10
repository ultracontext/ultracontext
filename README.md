# UltraContext - Same Context, Everywhere.

> One context layer for every AI agent on every machine.

UltraContext syncs Claude Code, Codex, OpenClaw, Hermes, and custom folders into a single workspace tree. Agents inspect that workspace directly through the installed UltraContext skill. No fake chatbot wrapper. Good riddance.

## Quickstart

```sh
curl -fsSL https://ultracontext.com/install.sh | sh
# or: npm install -g ultracontext

uc init
uc status
```

The install script starts `uc init` when it can use your terminal. With npm, run `uc init` after install.

Add more sources with `uc source add <name> <path>`.

The installer provides `ultracontext`, `uc`, and Mutagen when it is missing. SSH is needed for remote sync. Run `uc doctor` to verify.

## Why

Agents need horizontal intelligence, so they remain sharp and lean across sessions, machines, and tools by retrieving relevant context on demand.

- **Unified workspace** — Claude on your laptop, Codex on your desktop, OpenClaw on a VPS, all in one tree.
- **Files are truth** — raw session files, no proprietary format, no lock-in risk.
- **Agent-native retrieval** — agents use the installed skill and inspect the workspace themselves.
- **Self-hosted by default** — your machine, your VPS, your data.

## How it works

```text
~/.claude   ─┐
~/.codex    ─┼──▶  ~/.ultracontext/workspace/<host>/<source-folder>/
~/.openclaw ─┘                       │
~/.hermes   ─────────────────────────┘
                                      ▼
                              Agent + UltraContext skill
```

- One-way sync, real-time, conflict-free.
- Workspace lives wherever you want — your laptop, your VPS, your homelab.
- The installed skill tells agents how to search across every synced host and source.

## Commands

Main commands:

- `uc init [local|user@host]`: interactive onboarding: choose where UltraContext lives, choose sources, install skill, optionally start sync.
- `uc status`: show compact workspace and source sync overview.
- `uc doctor`: verify dependencies, config, and remote access.
- `uc update`: update using the active install manager.

Source commands:

- `uc source add <name> <path> [--disabled]`: add a source and start syncing it unless disabled.
- `uc source list`: list configured sources and their state.
- `uc source enable <name>` / `uc source disable <name>`: toggle one source.
- `uc source remove <name> [--yes]`: confirm, terminate sync, delete the remote copy, and remove the source from config. Local files stay in place.

Sync commands:

- `uc sync start`: start syncing every enabled source.
- `uc sync list`: list configured sync sessions and their current state.
- `uc sync status`: show Mutagen session state.
- `uc sync stop`: pause every enabled source.
- `uc sync reset`: recreate sessions after editing global settings or ignore rules.

Event commands:

- `uc event emit --kind <kind> --source <source> --subject <id> [--privacy metadata_only] [--label key=value]`: create a pending native UltraContext Event Envelope v1 and commit it to the configured server log.
- `uc event commit --from-stdin`: server-side commit path: read one event JSON from stdin, set/overwrite `received_at`, dedupe, and append to the server log.
- `uc event tail [--limit <n>]`: print recent committed events.
- `uc event flush`: retry events still pending in the local outbox.
- `uc event status`: show server, host id, pending outbox count, and sent count.

Native UC events use the versioned `uc.event.v1` envelope documented in `docs/primitives/event-envelope-v1.md`. Events are server-authoritative: `uc event emit` writes a pending envelope to the client outbox, then asks the configured server to run `uc event commit --from-stdin` when `uc` is installed remotely, with a Python server-side fallback for bare SSH hosts. The commit path sets/overwrites `received_at`, dedupes by `event_id`, and appends to `events/events.jsonl`. Clients keep a local durable outbox at `~/.ultracontext/events/outbox/` only for retry, then move committed events to `~/.ultracontext/events/sent/`. Events are small facts; large/detail payloads belong in artifacts referenced by `payload_ref`. Do not put raw prompts, transcripts, secrets, cookies, API keys, tokens, headers, signed URLs, or huge payloads in event JSON.

Driver commands:

- `uc driver list`: list installed external drivers from `~/.ultracontext/drivers/*/driver.toml`.
- `uc driver run <driver> <command>`: run a named installed driver command.

Drivers/adapters are external integration code around UC primitives, not core runtime dependencies. The core repo ships the driver contract and CLI only. Product-specific or community drivers are installed separately under `~/.ultracontext/drivers/<name>/driver.toml`.

Plugins are the opposite direction: UC context consumed inside a host runtime. The first plugin lives at `plugins/hermes/` and registers a Hermes `pre_llm_call` hook that injects a bounded `uc event tail` activity signal so the model knows when to use the UltraContext skill for deeper lookup. See `docs/plugins/README.md` and `docs/plugins/hermes.md`.

Advanced:

- `uc init local --no-sync`: configure a local workspace without starting sync.
- `uc init user@vps --yes`: non-interactive init for scripts.
- `uc init user@vps --host-id macbook --remote-root ~/.ultracontext --yes`: fully explicit non-interactive init.

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

Re-running the install command is an update. `uc init` can be rerun to reconfigure the workspace and sources. `uc doctor` warns if multiple installs are on PATH.

## Workspace layout

```text
~/.ultracontext/
  config.toml
  workspace/
    <host-id>/
      .claude/
      .codex/
      .openclaw/
      .hermes/
      <custom-source>/
```

Host comes first, then source folder. Built-in agent sources keep their native dot-folder names (`.claude`, `.codex`, `.openclaw`, `.hermes`) in the workspace; custom source names become folder names, so they are limited to letters, numbers, hyphens, and underscores.

## Config

`~/.ultracontext/config.toml`:

```toml
remote      = "user@vps"        # or "local"
remote_root = "~/.ultracontext"
host_id     = "macbook"

[sources.claude]
path    = "~/.claude"
enabled = true

[sources.codex]
path    = "~/.codex"
enabled = true
```

Ignore files live under `~/.ultracontext/ignores/` and use Mutagen's gitignore-style syntax. The global file is `~/.ultracontext/ignores/.ultracontextignore`; source-specific files live at `~/.ultracontext/ignores/<source>/.ultracontextignore`. `uc init` syncs Claude/Codex broadly with no source-specific default ignores; OpenClaw starts with conversations and complete workspace directories, excluding `node_modules`. Source changes apply immediately. Global settings and ignore edits apply on `uc sync reset`.

## Agent skill

`uc init` and `uc update` install the UltraContext skill into supported agent skill directories, including Claude, Codex-style `.agents`, OpenClaw, and Hermes (`~/.hermes/skills/ultracontext/SKILL.md`). That skill is the retrieval protocol: it tells agents to enumerate all synced hosts, inspect the right source folders, rank by internal timestamps, use fast paths like Codex `history.jsonl`, and open original transcripts when details matter.

For example, when a user asks for the latest Codex session, an agent should compare every `<host>/.codex/history.jsonl` and `<host>/.codex/sessions/**/rollout-*.jsonl`, not just the current machine. Local-only lookup is wrong unless the workspace itself is local-only.

## Development

```sh
cargo test                                       # unit + integration
npm run test:npm                                # npm installer mapping tests
sh -n install.sh                                # install script syntax
./install.sh --dev                              # local installer smoke test
cargo test --test e2e -- --ignored --nocapture   # real Mutagen E2E
```

Real E2E needs `UC_E2E_REMOTE=user@host`. Copy `.envrc.example` to `.envrc` for local runs.

## License

Apache-2.0.
