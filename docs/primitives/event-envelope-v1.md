# Event Envelope v1

## Purpose

The Event Envelope is the canonical, versioned shape for native UltraContext events.

An event is a small immutable fact that something happened. It is not a transcript, state dump, raw webhook payload, or secret container.

```text
event = small fact
artifact = large/detail payload
projection/index = derived state
```

## Status

Implemented contract in this worktree. The CLI now emits stored events with `schema_version = "uc.event.v1"`, `occurred_at`, `subject`, `privacy`, labels, structured errors, explicit `--event-id`, validation, and local/SSH dedupe by `event_id`.

This contract should remain the base before building subscriptions, interrupts, locks, or scheduler behavior on top.

## Non-goals

This document does not define:

- subscriptions;
- interrupt queues;
- scheduler execution;
- distributed locks;
- plugin marketplace;
- HTTP webhook server implementation;
- artifact storage internals.

## Contract

### Required fields

```text
schema_version
event_id
kind
source
subject
occurred_at
received_at
host
privacy
```

### Optional fields

```text
actor
run_id
trace_id
parent_event_id
priority
ok
payload_ref
payload_hash
counts
labels
error
```

### Field meanings

- `schema_version`: must be `uc.event.v1` for this contract.
- `event_id`: globally unique id used for idempotency/dedupe.
- `kind`: dotted event kind, e.g. `agent.run.completed`, `session.closed`, `sync.failed`.
- `source`: component/driver/agent that emitted or observed the event, e.g. `hermes`, `chatgpt-ios-shortcut`, `github-webhook`.
- `subject`: stable thing the event is about, e.g. `repo:ultracontext`, `chatgpt:session:abc123`, `agent-run:hermes:xyz`.
- `occurred_at`: when it happened in the source system.
- `received_at`: when UltraContext accepted/committed it.
- `host`: machine/client/server that emitted or committed it.
- `privacy`: one of `public`, `internal`, `metadata_only`, `sensitive_ref`.
- `actor`: who caused the event, e.g. `user:fabio`, `agent:hermes`, `driver:github`.
- `run_id`: id for one agent/tool run.
- `trace_id`: id for a larger causal chain across events.
- `parent_event_id`: direct causal parent event.
- `priority`: integer from `0` to `100`.
- `ok`: boolean success/failure marker when applicable.
- `payload_ref`: pointer to artifact/context containing large details.
- `payload_hash`: hash for referenced payload, preferably `sha256:<hex>`.
- `counts`: small numeric counters.
- `labels`: small string metadata for filtering/grouping.
- `error`: structured small error object.

## Storage

Native UC events are server-authoritative.

```text
Client:
  ~/.ultracontext/events/outbox/*.json
  ~/.ultracontext/events/sent/*.json

Server:
  <remote_root>/events/events.jsonl
  <remote_root>/events/seen/ or equivalent index for dedupe
```

The local outbox is only a durable retry buffer. The server log is the source of truth.

## CLI/API

Current/future CLI shape:

```bash
uc event emit \
  --kind session.closed \
  --source chatgpt-ios-shortcut \
  --subject chatgpt:session:abc123 \
  --actor user:fabio \
  --privacy metadata_only \
  --payload-ref uc://artifacts/chatgpt/sessions/abc123.md \
  --label provider=chatgpt \
  --label driver=ios-shortcut
```

Recommended stable flags for v1:

```text
--event-id <id>
--kind <kind>
--source <source>
--subject <subject>
--occurred-at <timestamp>
--actor <actor>
--run-id <id>
--trace-id <id>
--parent-event-id <id>
--priority <0-100>
--ok <true|false>
--payload-ref <ref>
--payload-hash sha256:<hex>
--privacy <public|internal|metadata_only|sensitive_ref>
--count key=value
--label key=value
--error-class <class>
--error-message <message>
--error-retryable <true|false>
```

## Examples

### Agent run completed

```json
{
  "schema_version": "uc.event.v1",
  "event_id": "evt_01...",
  "kind": "agent.run.completed",
  "source": "hermes",
  "subject": "agent-run:hermes:run_abc123",
  "occurred_at": "2026-05-08T12:00:00Z",
  "received_at": "2026-05-08T12:00:01Z",
  "host": "fabios-mac-mini",
  "actor": "agent:hermes",
  "run_id": "run_abc123",
  "priority": 60,
  "ok": true,
  "payload_ref": "uc://artifacts/hermes/runs/run_abc123.md",
  "privacy": "metadata_only",
  "counts": { "tests_passed": 53 },
  "labels": { "project": "ultracontext" }
}
```

### External driver: ChatGPT iOS Shortcut session closed

```json
{
  "schema_version": "uc.event.v1",
  "event_id": "evt_01...",
  "kind": "session.closed",
  "source": "chatgpt-ios-shortcut",
  "subject": "chatgpt:session:abc123",
  "occurred_at": "2026-05-08T12:10:00Z",
  "received_at": "2026-05-08T12:10:05Z",
  "host": "iphone-fabio",
  "actor": "user:fabio",
  "payload_ref": "uc://artifacts/chatgpt/sessions/abc123.md",
  "privacy": "metadata_only",
  "labels": { "provider": "chatgpt", "driver": "ios-shortcut" }
}
```

### External driver: GitHub PR opened

```json
{
  "schema_version": "uc.event.v1",
  "event_id": "evt_01...",
  "kind": "github.pr.opened",
  "source": "github-webhook",
  "subject": "github:repo:ultracontext:pr:123",
  "occurred_at": "2026-05-08T12:15:00Z",
  "received_at": "2026-05-08T12:15:01Z",
  "host": "uc-server",
  "actor": "user:fabio",
  "payload_ref": "uc://artifacts/github/webhooks/evt_01.json",
  "privacy": "internal",
  "labels": { "provider": "github", "repo": "ultracontext" }
}
```

## Initial canonical event kinds

Keep v1 small:

```text
uc.event.committed
uc.outbox.flush.started
uc.outbox.flush.completed
uc.outbox.flush.failed

agent.run.started
agent.run.completed
agent.run.failed
agent.artifact.created

session.opened
session.closed
sync.started
sync.completed
sync.failed

file.changed
git.commit.created
github.pr.opened

test.run.started
test.run.passed
test.run.failed
build.started
build.completed
build.failed
```

Provider-specific details should usually be in `source`, `subject`, and `labels`, not in many provider-specific `kind` values.

## External driver rule

A driver is any component that talks to something outside UltraContext.

Driver contract:

```text
external input -> optional artifact -> canonical UC event envelope
```

Examples:

- GitHub webhook driver receives webhook JSON, stores raw webhook as artifact, emits a canonical event.
- ChatGPT iOS Shortcut driver observes lifecycle, runs bounded sync, stores session artifact, emits `session.closed` / `sync.completed`.
- Claude/Codex watcher observes local session files, writes derived markdown artifact, emits `session.closed` / `agent.artifact.created`.

## Validation rules

- `schema_version` must be `uc.event.v1`.
- `kind`, `source`, `subject`, `occurred_at`, `received_at`, `host`, `privacy` are required.
- `kind` should be dotted and stable.
- `priority` must be between `0` and `100`.
- `privacy` must be one of `public`, `internal`, `metadata_only`, `sensitive_ref`.
- `payload_hash`, if present, must start with `sha256:`.
- `counts` values must be small numbers.
- `labels` values must be small strings.

## Privacy/security rules

Never put these inline in event JSON:

- raw prompts;
- full transcripts;
- passwords;
- tokens;
- cookies;
- API keys;
- auth headers;
- signed URLs;
- huge raw webhooks;
- email bodies;
- private message bodies.

Use `payload_ref`, `payload_hash`, small counts, and small labels instead.

## Compatibility/migration

The older architecture draft used fields like `at`, `subject_id`, and `error_class`.

For v1:

- `at` becomes `occurred_at`.
- `subject_id` becomes `subject`.
- `error_class` becomes `error.class`.

CLI compatibility can keep old flags temporarily, but stored v1 events should use the canonical names above.

## Tests required

Before production code changes:

- event emit writes `schema_version`, `occurred_at`, `received_at`, `privacy`, and required fields;
- invalid priority/privacy/hash fails cleanly;
- labels are rendered as a JSON object;
- structured error is rendered as a JSON object;
- duplicate `event_id` does not append duplicate server log lines;
- smoke test uses temporary `HOME` and does not mutate real user config.
