# Agent guide

ultracontext (`uc`) keeps Claude Code and Codex sessions the same on every machine. It does
not sync code (git does). One Rust binary is the hub, the per-machine daemon and the CLI.

## If you were asked to set up or use ultracontext

Follow [skills/uc/SKILL.md](skills/uc/SKILL.md). It explains what uc is, how it works, the
setup steps (install, pick a hub, `uc init`, `uc service install`, `uc doctor`) and daily
use. `uc init` also installs that skill into `~/.claude/skills/uc/` and `~/.codex/skills/uc/`.

## If you were asked to work on this repo

```sh
cargo build
cargo test                    # unit tests + multi-machine e2e (hub + machines on one box)
cargo fmt --check             # CI fails on unformatted code
e2e/run.sh --with-mac         # Docker: hub + 2 Linux machines over ssh (+ this Mac over tcp)
```

Layout:

| path | what |
|---|---|
| `src/hub/` | the hub: SQLite change log, blobs, append-only session logs, leases |
| `src/client/daemon.rs` | daemon wiring: hub link, watcher, control socket, timers |
| `src/client/logsync*.rs` | session sync: push/pull lines, ownership, forks, materialization |
| `src/drivers/` | per-agent knowledge: Claude Code and Codex file layouts, metadata, forks |
| `src/pathmap.rs` | `$HOME` rewriting in transcripts (`@@UC_HOME@@`) |
| `src/cli/` | commands; `--json` prints exactly one JSON document |
| `src/proto.rs` | wire protocol shared by hub, daemon and CLI |
| `skills/uc/SKILL.md` | the agent skill, embedded in the binary |
| `docs/DESIGN.md`, `docs/CLI.md` | the design contract and the command reference |

Rules:

- `docs/DESIGN.md` is the contract; code comments cite its sections (`DESIGN §6.4`). Change
  the doc with the behavior.
- Never sync secrets: drivers must classify credentials, caches and DBs as not synced.
- Never rewrite or replace a transcript an agent may still be writing; diverging lines
  become a fork, never a merge.
- Tests run against temp `HOME` / `UC_HOME` dirs. Do not run `uc` against your real
  `~/.claude`, `~/.codex` or `~/.ultracontext` while developing.
