# UltraContext

> Your AI agents share one memory. Across every machine, every tool, every session.

You spent four hours pairing with Claude on your laptop. Sit down at your desktop, open Codex — it knows nothing. UltraContext fixes that.

```sh
uc init user@vps --host-id macbook
uc sync start
uc search "what did we ship in the rewrite branch?"
```

Every Claude conversation, every Codex session, every agent folder you add syncs to one workspace. Any agent on any machine can search across all of it.

## Install

```sh
cargo install ultracontext
ln -sf ~/.cargo/bin/ultracontext ~/.cargo/bin/uc
uc doctor
```

Needs [Mutagen](https://mutagen.io), SSH, and [Claude Code](https://docs.claude.com/en/docs/claude-code) for search.

## Commands

| | |
|---|---|
| `uc init [local\|user@host]` | Pick a workspace target |
| `uc sync start` | Sync every source |
| `uc source add <name> <path>` | Add another folder |
| `uc search "..."` | Ask anything |
| `uc doctor` | Verify setup |

`uc` and `ultracontext` are the same binary.

## Config

`~/.ultracontext/config.toml` — remote target, host id, search agent, sources.
`~/.ultracontextignore` — every ignore rule, fully editable.

Files are truth. No database, no index, no proprietary format. Move it, copy it, grep it. It's just files.

Swap Claude for any CLI that accepts a prompt:

```toml
[search]
command = "codex"
args    = "--model gpt-5"
```

## Status

2.0 alpha. Self-hosted by default. Your machine, your VPS, your data.

## License

Apache-2.0.
