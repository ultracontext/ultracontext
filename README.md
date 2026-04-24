# UltraContext

UltraContext 2.0 is a Rust CLI for syncing local agent session files into a remote workspace.

The current MVP syncs local Claude and Codex sessions to:

```text
~/.ultracontext/workspace/sessions/<host-id>/<agent>/
```

## Development

Run the normal test suite:

```sh
cargo test
```

Run the end-to-end test against a real remote host:

```sh
cargo test --test e2e -- --ignored --nocapture
```

The E2E test requires `UC_E2E_REMOTE` to point at an SSH target with Mutagen access:

```sh
export UC_E2E_REMOTE=user@host
```

Set `UC_E2E_QUERY=1` to include the remote Claude query step.

For local development, copy `.envrc.example` to `.envrc` and adjust the values. `.envrc` is ignored by git.
