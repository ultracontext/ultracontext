# UltraContext

> Same context everywhere.

UltraContext is an intelligence layer that automatically captures everything your agents do during your sessions, stores it in a unified context server, and lets any agent get relevant context on demand across your entire system — through a CLI.

Fully open source. Self-hosted by default.

```sh
npm i -g ultracontext
uc init user@vps --host-id macbook
uc sync start
uc search "where did we leave off on the rewrite?"
```

## How it works

**1. Capture** — every session from every agent on every machine streams into your context server in real time. Nothing to remember, nothing to copy.

**2. Store** — you own the files. Plain session files on your server, ready for agentic search. Bring QMD, GBrain, or your own tools.

**3. Consume** — `uc search` gives any agent the right context on demand. Search runs on the server. Your context window stays lean.

## Commands

| | |
|---|---|
| `uc init [local\|user@host]` | Pick where the context server lives |
| `uc sync start` | Capture every source |
| `uc source add <name> <path>` | Add another agent folder |
| `uc search "..."` | Ask anything |
| `uc doctor` | Verify setup |

`uc` and `ultracontext` are the same binary.

## Config

`~/.ultracontext/config.toml` — server target, host id, search agent, sources.
`~/.ultracontextignore` — every ignore rule, fully editable.

Files are truth. No database, no index, no proprietary format. Move it, copy it, grep it.

Swap Claude for any CLI that takes a prompt:

```toml
[search]
command = "codex"
args    = "--model gpt-5"
```

## Status

2.0 alpha. Your machine, your server, your data.

## License

Apache-2.0.
