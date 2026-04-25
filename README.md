# UltraContext

> Same context everywhere.

A unified source of truth that gives every agent instant context across your entire system. Fully open source.

You spend four hours pairing with Claude on your laptop. You sit down at your desktop, open Codex, and it knows nothing. UltraContext fixes that.

```sh
npm i -g ultracontext
uc init user@vps --host-id macbook
uc sync start
uc search "where did we leave off on the rewrite?"
```

## How it works

**1. Ingest** — sessions from every agent on every machine sync to one workspace, in real time.

**2. Store** — you own the files. Plain session files on your server, ready for agentic search. Bring QMD, GBrain, or your own tools.

**3. Consume** — `uc search` gives any agent the right context on demand. Search runs on the server. Your context window stays lean.

## Commands

| | |
|---|---|
| `uc init [local\|user@host]` | Pick where the workspace lives |
| `uc sync start` | Sync every source |
| `uc source add <name> <path>` | Add another folder |
| `uc search "..."` | Ask anything |
| `uc doctor` | Verify setup |

`uc` and `ultracontext` are the same binary.

## Config

`~/.ultracontext/config.toml` — workspace target, host id, search agent, sources.
`~/.ultracontextignore` — every ignore rule, fully editable.

Files are truth. No database, no index, no proprietary format. Move it, copy it, grep it.

Swap Claude for any CLI that takes a prompt:

```toml
[search]
command = "codex"
args    = "--model gpt-5"
```

## Status

2.0 alpha. Self-hosted by default. Your machine, your VPS, your data.

## License

Apache-2.0.
