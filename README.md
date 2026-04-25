# UltraContext

UltraContext 2.0 is a context sync CLI.

It syncs local agent context into one UltraContext workspace so Claude, Codex, and other agents can recover context across machines.

## Quickstart

Install the CLI from this checkout:

```sh
cargo install --path . --force
ln -sf ~/.cargo/bin/ultracontext ~/.cargo/bin/uc
```

Initialize this machine:

```sh
uc init user@host --host-id my-mac
```

Initialize on the machine that owns the UltraContext folder:

```sh
uc init local --host-id workspace-host
```

Start syncing local agent context:

```sh
uc sync start
uc sync status
```

Search your UltraContext:

```sh
uc search "what changed in the sync CLI?"
```

If sync source paths or sync settings change, recreate the sync sessions:

```sh
uc sync reset
```

## Model

UltraContext runs locally, uses Mutagen for sync, and searches the UltraContext workspace with Claude. The workspace can be local (`uc init local`) or remote over SSH (`uc init user@host`).

```text
~/.claude  ----\
               \
~/.codex   ----->  ~/.ultracontext/workspace/sessions/<host-id>/<agent>/
```

The remote layout keeps machine and agent boundaries explicit:

```text
~/.ultracontext/
  workspace/
    sessions/
      <host-id>/
        claude/
          ...
        codex/
          ...
```

Sync is one-way: local agent folders are mirrored into the UltraContext workspace. In remote mode, search runs over SSH on the remote host. In local mode, search runs directly against the local workspace.

UltraContext does not redact source files or search output. It does ignore generated dependency/build/cache directories by default to keep sync and search usable.

## CLI

Initialize a machine:

```sh
ultracontext init user@host --host-id my-mac
```

Initialize local workspace mode:

```sh
ultracontext init local --host-id workspace-host
```

Start sync:

```sh
ultracontext sync start
```

Check sync:

```sh
ultracontext sync status
```

Recreate sync sessions after changing source paths:

```sh
ultracontext sync reset
```

Search context:

```sh
ultracontext search "what changed in the sync CLI?"
```

`uc` should point to the same binary as `ultracontext`:

```sh
uc sync start
uc search "what changed?"
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

Local mode stores and searches the workspace on the same machine:

```toml
remote = "local"
remote_root = "~/.ultracontext"
```

Ignore file:

```text
~/.ultracontextignore
```

Built-in ignores:

```text
node_modules/
.git/
target/
dist/
build/
.next/
.cache/
```

Add extra generated-noise patterns to `.ultracontextignore`. Secrets and agent context files such as `.env`, `auth.json`, `credentials.json`, and `session-env` are not ignored by default. Ignore changes apply when sync sessions are created, so run `uc sync reset` after editing `.ultracontextignore`.

`uc init` and `uc sync start` create a template `.ultracontextignore` if it does not exist.

Customize the remote search command in `config.toml`:

```toml
[search]
command = "claude"
args = "--dangerously-skip-permissions"
```

Config is read fresh on every `uc` command. Search command changes apply on the next `uc search`; sync source, remote, or ignore changes need `uc sync reset` to recreate Mutagen sessions.

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

Enable the remote Claude search step:

```sh
export UC_E2E_SEARCH=1
```

For local development, copy `.envrc.example` to `.envrc`. `.envrc` is ignored by git.
