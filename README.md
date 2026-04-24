# UltraContext

UltraContext 2.0 is a context sync CLI.

It syncs local agent sessions into a remote workspace so Claude, Codex, and other agents can recover context across machines.

## Model

UltraContext runs locally, uses Mutagen for sync, and uses SSH to prepare/query the remote workspace.

```text
~/.claude/projects  ----\
                        \
~/.codex/sessions   ----->  ~/.ultracontext/workspace/sessions/<host-id>/<agent>/
```

The remote layout keeps machine and agent boundaries explicit:

```text
~/.ultracontext/
  workspace/
    sessions/
      <host-id>/
        claude/
          projects/
        codex/
          sessions/
```

Sync is one-way: local session files flow to the remote workspace. Query runs on the remote host with Claude over the synced files.

## CLI

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

Query remote context:

```sh
ultracontext query "what changed in the sync CLI?"
```

`uc` should point to the same binary as `ultracontext`:

```sh
uc sync start
uc query "what changed?"
```

## Config

Local config:

```text
~/.ultracontext/config.toml
```

Default remote root:

```text
~/.ultracontext
```

## Development

Run unit and integration tests:

```sh
cargo test
```

Run the real E2E test:

```sh
cargo test --test e2e -- --ignored --nocapture
```

The E2E test needs a remote SSH target:

```sh
export UC_E2E_REMOTE=user@host
```

Enable the remote Claude query step:

```sh
export UC_E2E_QUERY=1
```

For local development, copy `.envrc.example` to `.envrc`. `.envrc` is ignored by git.
