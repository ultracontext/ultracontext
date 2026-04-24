# UltraContext

UltraContext 2.0 is a context sync CLI.

It syncs local agent session files into one remote workspace so agents can recover useful context across machines, tools, and runs.

The first version is intentionally simple:

- `ultracontext` is the main binary.
- `uc` should be an alias or symlink to the same binary.
- Sync is local-to-remote only.
- Mutagen handles file synchronization.
- SSH handles remote access.
- Claude is the first remote query agent.
- There is no UltraContext server, UltraContext daemon, container, database, MCP layer, inbox, or index yet.

## Vision

Local coding agents already write valuable session history, but that context stays trapped inside machine-local folders like `~/.claude` and `~/.codex`.

UltraContext turns those native session folders into a shared remote context layer.

The remote workspace is not meant to be a product database at this stage. It is a normalized filesystem mirror that every agent can inspect. The important part is the shape:

```text
~/.ultracontext/workspace/sessions/<host-id>/<agent>/
```

That structure lets a query agent understand:

- which machine produced the context;
- which agent produced it;
- where the original session files came from;
- what happened across the whole system.

The goal is not only to ask "what did Claude do?" or "what did Codex do?". The goal is to ask about a subject, project, bug, branch, or decision, and let the search agent infer which sessions, agents, and machines matter.

## Architecture

UltraContext runs locally as a CLI.

The local CLI owns configuration, prepares the remote workspace over SSH, and asks Mutagen to sync native session directories into the remote layout.

The remote machine does not need an UltraContext server for the MVP. It only needs SSH access for sync setup and, for query, a usable Claude CLI.

```text
local machine
  ~/.claude/projects  --------\
                              \
  ~/.codex/sessions   --------->  mutagen over ssh  ->  remote ~/.ultracontext/workspace

remote machine
  claude -p "<query>" --dangerously-skip-permissions
```

The current query path runs Claude on the remote host against the synced workspace. This keeps the first implementation agentic and avoids building indexing infrastructure before we know we need it.

## Remote Layout

Local folders keep their native names:

```text
~/.claude/projects
~/.codex/sessions
```

Remote folders are normalized and do not keep the leading dot from the agent config directories:

```text
~/.ultracontext/
  workspace/
    sessions/
      <host-id>/
        claude/
          projects/
            ...
        codex/
          sessions/
            ...
```

`workspace` is singular on purpose. It is the default workspace. We are not introducing multi-workspace complexity until the product needs it.

## Sync Model

Sync is one-way from the local machine to the remote workspace.

The remote workspace is a mirror for shared context, not the source of truth for local agent state.

UltraContext currently creates one Mutagen session per local source:

```text
uc-<host-id>-claude
uc-<host-id>-codex
```

Mutagen runs in `one-way-safe` mode so local session files flow to the remote workspace without treating the remote as an editable peer.

## CLI Shape

Initialize a machine:

```sh
ultracontext init user@host --host-id my-mac
```

Start sync:

```sh
ultracontext sync start
```

Check sync:

```sh
ultracontext sync status
```

Stop sync:

```sh
ultracontext sync stop
```

Query remote context:

```sh
ultracontext query "what happened with the onboarding refactor?"
```

Check local requirements:

```sh
ultracontext doctor
```

The short command should be:

```sh
uc sync start
uc query "what changed?"
```

`uc` should point to the same binary as `ultracontext`.

## Config

Local configuration lives at:

```text
~/.ultracontext/config.toml
```

The default remote root is:

```text
~/.ultracontext
```

The remote sessions root is:

```text
~/.ultracontext/workspace/sessions
```

## Non-Goals For The MVP

These are intentionally out of scope for now:

- no remote UltraContext server;
- no UltraContext daemon;
- no container;
- no SQLite;
- no inbox;
- no MCP integration;
- no index or reindex cron;
- no `.ultracontext/workspace/queries` folder;
- no bidirectional sync;
- no multi-workspace model.

If query latency or quality becomes a real problem, we can add indexing later. For now, the simplest useful path is to sync the raw session files and run an agentic search over them.

## Development

Run the normal Rust test suite:

```sh
cargo test
```

Run the end-to-end test against a real remote host:

```sh
cargo test --test e2e -- --ignored --nocapture
```

The E2E test requires a remote SSH target:

```sh
export UC_E2E_REMOTE=user@host
```

Set this to include the remote Claude query step:

```sh
export UC_E2E_QUERY=1
```

For local development, copy `.envrc.example` to `.envrc` and adjust the values. `.envrc` is ignored by git.
