# Driver Adapter v1

## Purpose

Driver Adapter v1 defines how code that talks to external systems plugs into UltraContext without becoming part of the core runtime.

Examples:

- browser/app syncers
- iOS Shortcut relays
- GitHub, email, calendar, or other app syncers

A driver is a side-effect boundary. It may know how to talk to Chrome, AppleScript, logged-in web apps, exports, local files, or third-party APIs. UltraContext core only sees versioned primitives: events, artifact references, checkpoints, and later subscriptions/scheduler state.

## Status

Draft contract. The first implementation slice supports local driver manifests plus:

```text
uc driver list
uc driver run <driver> <command>
```

## Non-goals

- Drivers are not trusted core code.
- Drivers are not allowed to store secrets in manifests.
- Drivers are not required to be Rust.
- Drivers do not define new Event Envelope schemas.
- Drivers do not make UltraContext depend on any one vendor.

## Contract

A driver is a directory with a `driver.toml` manifest:

```toml
name = "example-app"
version = "0.1.0"
type = "external-app-sync"
runtime = "python"

[capabilities]
events = true
artifacts = true
bounded_sync = true
requires_logged_in_browser = true

[commands]
opened = "example-driver opened --limit 10"
closed = "example-driver closed --limit 10 --settle-seconds 5"
poll = "example-driver poll --limit 10"
```

Required fields:

- `name`: stable driver id, lowercase kebab-case.
- `version`: driver package version.
- `[commands]`: named commands exposed through `uc driver run`.

Recommended fields:

- `type`: broad class such as `external-app-sync`.
- `runtime`: runtime hint such as `python`, `rust`, `node`, or `shell`.
- `[capabilities]`: booleans describing what primitives the driver produces.

Command names should be stable verbs:

- `opened`
- `closed`
- `poll`
- `sync-recent`
- `status`
- `doctor`

## Storage

Local installed drivers live under:

```text
~/.ultracontext/drivers/<driver-name>/driver.toml
```

A community driver package may keep versioned manifests in its own repo, for example:

```text
drivers/<driver-name>/driver.toml
```

The local installed location is the runtime source of truth for `uc driver` commands.

Drivers should write mirrored app artifacts under UltraContext-controlled roots or emit artifact refs that point to them. Product-specific drivers should stay outside the UC core repo.

## CLI/API

```bash
uc driver list
uc driver run <driver> opened
uc driver run <driver> closed
uc driver run <driver> poll
```

`uc driver run` executes the command declared in the manifest. The command runs as a local process on the host where the driver is installed.

For iOS relay usage, the server relay should SSH to the Mac and run `uc driver run ...` on the Mac. The relay should not call Hermes script paths directly.

## Example

Community app driver opened:

```bash
uc driver run <driver> opened
```

Expected driver output effects:

- bounded sync may update mirrored app artifacts.
- driver emits one lifecycle `uc.event.v1` after the bounded sync finishes:

```json
{
  "kind": "app.opened",
  "source": "example-app-ios-shortcut",
  "subject": "example-app:app:ios",
  "privacy": "metadata_only",
  "counts": {
    "listed": 10,
    "candidates": 1,
    "fetched": 1,
    "synced": 1,
    "changed_sessions": 1
  },
  "labels": {
    "app": "example-app",
    "platform": "ios",
    "trigger": "opened"
  }
}
```

For each changed session, the driver also emits a separate context-bearing event:

```json
{
  "kind": "example-app.session.updated",
  "source": "example-app-driver",
  "subject": "example-app:session:abc123",
  "parent_event_id": "evt_app_opened_...",
  "trace_id": "evt_app_opened_...",
  "payload_ref": "file:///Users/example/.example-app/sessions/abc123.md",
  "payload_hash": "sha256:<markdown-sha256>",
  "privacy": "metadata_only",
  "counts": {
    "message_count": 10
  },
  "labels": {
    "app": "example-app",
    "agent": "example-app",
    "trigger": "opened",
    "title": "Session title"
  }
}
```

Drivers should prefer one event per changed session over embedding a driver-specific `changed_sessions[]` array in a generic lifecycle payload. This keeps the consumer contract simple: agents can watch `*.session.updated`, read `payload_ref`, score relevance, and continue.

## Validation rules

- Manifest must contain `name`.
- Manifest directory name should match `name`.
- `uc driver run <driver> <command>` must fail if the driver or command is missing.
- Driver commands must be bounded by default for lifecycle hooks. No all-pages crawl from `opened`/`closed`.
- Driver output must not be required for Event Log correctness; the driver must emit UC events itself or call UC primitives.
- Lifecycle commands that sync sessions must emit `*.session.updated` events for changed session artifacts with `payload_ref` and `payload_hash`.

## Privacy/security rules

Driver manifests must not contain:

- cookies
- tokens
- passwords
- auth headers
- signed URLs
- private prompts/session bodies

Events emitted by lifecycle drivers should default to:

```text
privacy = metadata_only
```

Large or sensitive payloads must be artifacts addressed by references/hashes, not embedded in event payloads.

## Compatibility/migration

Prototype or community scripts may remain outside the UC core repo. When wrapped by `driver.toml`, they should be treated as installed external drivers.

Migration path:

1. Add manifests in `~/.ultracontext/drivers/*/driver.toml`.
2. Add `uc driver list/run`.
3. Update relays to call `uc driver run`.
4. Move product-specific driver implementation into separate community driver repos/packages.
5. Keep shims for old paths until users migrate.

## Tests required

- `uc driver list` shows installed local manifests.
- `uc driver run <driver> <command>` executes the command from the manifest.
- Missing driver fails clearly.
- Missing command fails clearly.
- iOS relay commands call `uc driver run`, not Hermes script paths.
