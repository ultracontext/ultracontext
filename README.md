# UltraContext

> Your AI agents share one memory. Across every machine, every tool, every session.

You spent four hours pairing with Claude on your laptop. You sit down at your desktop, open Codex, and it knows nothing. You switch from Claude to Cursor mid-task and lose the thread. Your agent on the VPS has no idea what your local agent already tried.

UltraContext fixes that. It mirrors every agent's session folder into one workspace, so any agent on any machine can search across all of it.

```sh
$ uc search "what did we decide about the ignore file last night?"

Last night you and Codex moved every ignore pattern out of the Rust binary
into ~/.ultracontextignore. .git/ included. Reasoning: user owns ignore
policy, hardcoded defaults contradicted "files are the truth". Commit
0dc5aa3 on rewrite/2.0. Tests in src/main.rs around line 1690 verify the
template carries every expected pattern.
```

That answer came from a session you had on a different machine, with a different agent.

## Install

```sh
cargo install ultracontext
ln -sf ~/.cargo/bin/ultracontext ~/.cargo/bin/uc
```

Requires [Mutagen](https://mutagen.io) (`brew install mutagen-io/mutagen/mutagen`), SSH, and [Claude Code](https://docs.claude.com/en/docs/claude-code) for search. Check setup:

```sh
uc doctor
```

## 60 seconds to value

Sync your laptop into a VPS workspace:

```sh
uc init user@vps --host-id macbook
uc sync start
```

That's it. Every Claude conversation, every Codex session, every custom agent folder you've added now lives on the VPS, mirrored continuously.

Now ask anything:

```sh
uc search "where did we leave off on the rewrite branch?"
uc search "the bug we hit with the auth middleware last week"
uc search "what did codex try before we switched to claude on this?"
```

The search agent reads the synced files and returns the relevant context — not a final answer. You inject it into whatever agent you're talking to next.

## Use cases

**Switch machines mid-task.** Start with Claude on your laptop, finish with Codex on your desktop. Same context.

**Switch agents mid-task.** Hit Claude's context window, drop into Codex. Pick up where Claude left off.

**Audit what an agent did.** "What changes did Claude make to the auth code three weeks ago, and why?" Real answer, from real sessions.

**Recover from a crash.** Claude crashed. Reopen and ask: "what was I working on with you?"

**Cross-team context.** Add a teammate's session folder as a source. Their agent knows what your agent already tried.

## How it works

```text
~/.claude   ─┐
~/.codex    ─┼──▶  ~/.ultracontext/workspace/sessions/<host>/<agent>/
~/.openclaw ─┘                       │
                                     ▼
                                 uc search  ──▶  Claude (or any agent)
```

- **One workspace, many sources.** Every agent folder syncs to one tree.
- **Files are truth.** No database, no index, no proprietary format. Move it, copy it, grep it, delete it. It's just files.
- **Agentic search.** A context-engineer prompt drives Claude (or any CLI you configure) over the workspace. No vector store to rebuild, no embeddings to refresh.
- **SSH-only.** Self-hosted by default. Your machine, your VPS, your data.
- **One-way sync.** Local agent folders → workspace. Conflict-free.

## Commands

| Command | What it does |
|---|---|
| `uc init [local\|user@host]` | Configure workspace target and detect agent folders |
| `uc sync start` | Start syncing every enabled source |
| `uc sync status` | Show sync state |
| `uc sync stop` | Pause every source |
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

Host first, then agent. Source names become folder names — letters, numbers, hyphens, underscores only.

## Config

`~/.ultracontext/config.toml`:

```toml
remote      = "user@vps"
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

Reloads every command. Source changes apply immediately. Global setting and ignore changes apply on `uc sync reset`.

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

Run `uc sync reset` after edits.

Secrets and agent context (`.env`, `auth.json`, `credentials.json`) are **never** redacted. Files are the truth.

## Search

`uc search` runs your configured agent against the workspace with a context-engineer prompt. The agent returns context to inject into your next prompt — not a final answer.

Customize the prompt:

```text
src/prompts/context-engineer.md
```

Customize the agent:

```toml
[search]
command = "codex"
args    = "--model gpt-5"
```

Any CLI that accepts a prompt works.

## Non-goals

- **No vector database.** Embeddings rot, indexes drift, agents are smart enough to grep.
- **No SaaS.** Self-hosted. Your VPS, your laptop, your data.
- **No proprietary format.** Raw session files, exactly as agents write them.
- **No daemon you have to babysit.** Sync runs as a background process, search runs on demand.
- **No bidirectional sync.** Local is the source. Workspace mirrors. Conflicts can't happen.

## FAQ

**Why not just use git?** Agent session files churn constantly and contain large blobs. Git would explode. Mirror semantics fit the workload.

**Why not MCP?** MCP is on the roadmap as one consumer of UltraContext, not a replacement. The workspace works for any agent — including ones without MCP support.

**Why not a vector index?** Indexes need maintenance, embeddings need a model, agents are good at grep. Skip the layer until it earns its keep.

**Can I use Codex / GPT / a local model for search?** Yes. `[search] command` accepts any CLI that takes a prompt.

**What about secrets?** Files sync as-is. `.env`, `auth.json`, and credential files are not redacted. UltraContext is for trusted machines you own.

**Multi-user?** Out of scope for 2.0. The workspace is per-person.

## Status

UltraContext 2.0 is in alpha. Sync engine, source management, ignore rules, and remote/local search work end-to-end. On deck: bundled Mutagen install, `uc source status`, sharper `uc doctor`, and a public crate.

## Development

```sh
cargo test                                       # unit + integration
cargo test --test e2e -- --ignored --nocapture   # real Mutagen E2E
```

Real E2E needs `UC_E2E_REMOTE=user@host`. Optional `UC_E2E_SEARCH=1` exercises remote search. Copy `.envrc.example` to `.envrc` for local runs.

## License

Apache-2.0.
